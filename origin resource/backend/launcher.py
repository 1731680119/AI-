"""Windows 安装版托盘启动器。"""
from __future__ import annotations

import ctypes
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import socket
import threading
import time
import webbrowser

import pystray
import uvicorn
from PIL import Image, ImageDraw

from main import app
from paths import DATA_DIR, LOG_DIR, RUNTIME_DIR, ensure_data_dirs


HOST = "127.0.0.1"
APP_TITLE = "Chatbot"


class TrayLauncher:
    def __init__(self) -> None:
        self.server: uvicorn.Server | None = None
        self.server_thread: threading.Thread | None = None
        self.listen_socket: socket.socket | None = None
        self.port: int | None = None
        self.icon: pystray.Icon | None = None
        self.lock = threading.RLock()

    @property
    def url(self) -> str:
        return f"http://{HOST}:{self.port}" if self.port else ""

    def start_server(self) -> None:
        with self.lock:
            if self.server_thread and self.server_thread.is_alive():
                return

            listen_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listen_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listen_socket.bind((HOST, 0))
            listen_socket.listen(128)
            self.port = listen_socket.getsockname()[1]
            self.listen_socket = listen_socket

            config = uvicorn.Config(
                app,
                host=HOST,
                port=self.port,
                log_level="warning",
                access_log=False,
                use_colors=False,
            )
            self.server = uvicorn.Server(config)
            self.server_thread = threading.Thread(
                target=self.server.run,
                kwargs={"sockets": [listen_socket]},
                name="chatbot-server",
                daemon=True,
            )
            self.server_thread.start()

        self._wait_until_ready()
        (RUNTIME_DIR / "server.json").write_text(
            json.dumps({"url": self.url}), encoding="utf-8"
        )
        logging.info("Chatbot 已启动：%s", self.url)

    def _wait_until_ready(self, timeout: float = 20.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.server and self.server.started:
                return
            if self.server_thread and not self.server_thread.is_alive():
                raise RuntimeError("本地服务启动失败，请查看日志。")
            time.sleep(0.1)
        raise TimeoutError("等待本地服务启动超时，请查看日志。")

    def stop_server(self) -> None:
        with self.lock:
            server = self.server
            thread = self.server_thread
            if server:
                server.should_exit = True
        if thread and thread.is_alive():
            thread.join(timeout=10)
        with self.lock:
            if self.listen_socket:
                try:
                    self.listen_socket.close()
                except OSError:
                    pass
            self.server = None
            self.server_thread = None
            self.listen_socket = None
            self.port = None
            try:
                (RUNTIME_DIR / "server.json").unlink(missing_ok=True)
            except OSError:
                pass

    def open_browser(self, _icon=None, _item=None) -> None:
        if self.url:
            webbrowser.open(self.url)

    def restart(self, _icon=None, _item=None) -> None:
        def worker() -> None:
            try:
                self.stop_server()
                self.start_server()
                self.open_browser()
            except Exception:
                logging.exception("重启 Chatbot 失败")

        threading.Thread(target=worker, name="chatbot-restart", daemon=True).start()

    def quit(self, icon=None, _item=None) -> None:
        self.stop_server()
        (icon or self.icon).stop()

    def run(self) -> None:
        self.start_server()
        self.icon = pystray.Icon(
            APP_TITLE,
            _create_default_image(),
            APP_TITLE,
            menu=pystray.Menu(
                pystray.MenuItem("打开 Chatbot", self.open_browser, default=True),
                pystray.MenuItem("重启服务", self.restart),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("退出 Chatbot", self.quit),
            ),
        )
        threading.Timer(0.4, self.open_browser).start()
        self.icon.run()


def _create_default_image() -> Image.Image:
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((5, 7, 59, 52), radius=14, fill=(70, 70, 76, 255))
    draw.polygon(((20, 50), (17, 61), (32, 51)), fill=(70, 70, 76, 255))
    draw.ellipse((18, 27, 24, 33), fill="white")
    draw.ellipse((29, 27, 35, 33), fill="white")
    draw.ellipse((40, 27, 46, 33), fill="white")
    return image


def _configure_logging() -> None:
    ensure_data_dirs()
    handler = RotatingFileHandler(
        LOG_DIR / "chatbot.log",
        maxBytes=1_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[handler],
    )


def _acquire_user_mutex():
    if not hasattr(ctypes, "windll"):
        return None
    profile_id = hashlib.sha256(str(DATA_DIR).lower().encode("utf-8")).hexdigest()[:20]
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, f"Local\\Chatbot_{profile_id}")
    if not handle or ctypes.windll.kernel32.GetLastError() == 183:
        return None
    return handle


def _open_existing_instance() -> None:
    try:
        state = json.loads((RUNTIME_DIR / "server.json").read_text(encoding="utf-8"))
        url = state.get("url", "")
        if url.startswith("http://127.0.0.1:"):
            webbrowser.open(url)
    except (OSError, ValueError, TypeError):
        logging.info("未找到现有 Chatbot 实例的地址")


def main() -> int:
    _configure_logging()
    mutex = _acquire_user_mutex()
    if hasattr(ctypes, "windll") and mutex is None:
        logging.info("当前用户的 Chatbot 已经运行")
        _open_existing_instance()
        return 0

    launcher = TrayLauncher()
    try:
        launcher.run()
        return 0
    except Exception:
        logging.exception("Chatbot 启动失败")
        if hasattr(ctypes, "windll"):
            ctypes.windll.user32.MessageBoxW(
                None,
                f"Chatbot 启动失败。\n请查看日志：\n{LOG_DIR / 'chatbot.log'}",
                APP_TITLE,
                0x10,
            )
        return 1
    finally:
        launcher.stop_server()
        if mutex and hasattr(ctypes, "windll"):
            ctypes.windll.kernel32.CloseHandle(mutex)


if __name__ == "__main__":
    raise SystemExit(main())
