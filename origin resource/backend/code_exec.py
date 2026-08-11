"""代码执行：让模型写一段 Python 并在本机跑出结果。

这是全项目风险最高的一个功能，所以三道闸各自独立，少任何一道都不放行：

  1. 总开关 code_exec_enabled 默认关。关着时工具根本不声明给模型，
     而不是「声明了但执行时拒绝」——后者会让模型反复尝试。
  2. 每次执行前弹确认框，用户看到完整代码，可以改完再放行。
     用户可以选择在本轮对话内不再询问，切换会话即失效。
  3. 执行前用 AST 静态检查 import 与危险名字，不在白名单内直接拒绝，
     理由回填给模型让它自己改写。

必须说清楚这套机制的边界：子进程用 -I -S -E 起（隔离模式、不读
site-packages、不继承环境变量），cwd 锁在一次性临时目录里，但它仍以当前
用户身份运行。AST 白名单是代码层面的限制，不是操作系统层面的沙箱，
理论上存在绕过手段。因此它的定位是「防止模型误伤，并让用户看清每一次
执行」，而不是「防御刻意构造的恶意代码」。真正的隔离需要 Windows Job
Object 或 AppContainer。
"""
import ast
import hashlib
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Generator

import logging_config as diag
from paths import RUNTIME_DIR


TOOL_NAME = "run_code"

# 纯计算标准库。刻意不含 os / sys / subprocess / socket / ctypes / importlib /
# pathlib / shutil：这些要么能碰文件系统，要么能联网，要么能绕过本模块的检查。
ALLOWED_MODULES = frozenset({
    "math", "cmath", "statistics", "decimal", "fractions", "numbers", "random",
    "itertools", "functools", "operator", "collections", "heapq", "bisect", "array",
    "json", "re", "string", "textwrap", "unicodedata", "difflib",
    "datetime", "calendar", "zoneinfo", "time",
    "csv", "io", "pprint", "typing", "dataclasses", "enum", "copy",
    "hashlib", "hmac", "base64", "binascii", "uuid", "secrets", "struct",
})

# 反射和动态求值是 AST 白名单最直接的绕过口子，按名字拦掉。
BANNED_NAMES = frozenset({
    "eval", "exec", "compile", "open", "__import__", "input", "breakpoint",
    "globals", "locals", "vars", "memoryview", "exit", "quit", "help",
})

# 一次执行的硬上限。死循环最多占 15 秒，输出最多 100KB。
TIMEOUT_SECONDS = 15
MAX_OUTPUT_BYTES = 100 * 1024

# 确认框最长等待时间。用户直接关窗口时不能让线程永久挂住，超时按拒绝处理。
DECISION_TIMEOUT_SECONDS = 120

EXEC_DIR = RUNTIME_DIR / "exec"

TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": (
            "在用户本机运行一段 Python 代码并拿到输出，用于精确计算、数据处理、"
            "验证算法。结果必须通过 print 输出，否则你看不到任何东西。"
            "只能使用纯计算标准库（math、statistics、json、re、datetime、itertools、"
            "collections、decimal、hashlib 等）；不能读写文件、不能联网、"
            "不能使用 os/sys/subprocess/pathlib，也不能用 numpy/pandas 这类第三方库。"
            "每次运行都需要用户点击确认，因此不要用它做能直接算出来的小事。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "要执行的 Python 代码。用 print 输出结果。",
                },
                "purpose": {
                    "type": "string",
                    "description": "一句话说明这段代码要做什么，会展示给用户看，帮助他判断是否放行。",
                },
            },
            "required": ["code"],
        },
    },
}


class CodeRejected(Exception):
    """代码没通过静态检查。理由会回填给模型，让它换个写法。"""


def is_configured(settings: dict) -> bool:
    """总开关关着时不声明这个工具，避免模型调用一个必然被拒的工具。"""
    return bool(settings.get("code_exec_enabled", False))


def check_code(code: str) -> list[str]:
    """静态检查，通过则返回用到的模块名，不通过抛 CodeRejected。"""
    if not code.strip():
        raise CodeRejected("代码为空")
    try:
        tree = ast.parse(code)
    except SyntaxError as error:
        raise CodeRejected(f"语法错误：第 {error.lineno} 行 {error.msg}") from error

    used: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                used.add(_check_module(alias.name))
        elif isinstance(node, ast.ImportFrom):
            # from . import x 没有模块名，相对导入在这里没有意义，直接拒。
            if node.level or not node.module:
                raise CodeRejected("不允许相对导入")
            used.add(_check_module(node.module))
        elif isinstance(node, ast.Name) and node.id in BANNED_NAMES:
            raise CodeRejected(f"不允许使用 {node.id}")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            # __class__ / __subclasses__ / __globals__ 这条链是逃逸的经典路径。
            raise CodeRejected(f"不允许访问内部属性 {node.attr}")
    return sorted(used)


def _check_module(name: str) -> str:
    """只看顶层包名：白名单里的模块没有需要单独放行的子模块。"""
    top = name.split(".")[0]
    if top not in ALLOWED_MODULES:
        raise CodeRejected(
            f"不允许导入 {name}。可用的只有纯计算标准库，"
            f"例如 math、statistics、json、re、datetime、itertools、collections、decimal"
        )
    return top


# ---------- 待批准队列 ----------
# 工具执行发生在 SSE 流的生成器里，确认结果却要经另一条 HTTP 请求进来，
# 所以需要一张共享的待批表把两者接上。
_pending: dict[str, dict] = {}
_lock = threading.Lock()

# 用户勾选「本轮对话内不再询问」的会话。进程重启即清空，不落库：
# 免询问是一次临时授权，不应该跨重启存活。
_trusted_conversations: set[str] = set()


def trust_conversation(conversation_id: str) -> None:
    if conversation_id:
        _trusted_conversations.add(conversation_id)


def revoke_conversation(conversation_id: str) -> None:
    _trusted_conversations.discard(conversation_id)


def is_trusted(conversation_id: str) -> bool:
    return bool(conversation_id) and conversation_id in _trusted_conversations


def submit_decision(request_id: str, approved: bool, code: str | None = None) -> bool:
    """前端点了允许/拒绝。code 非空表示用户改过代码，按改后的版本执行。"""
    with _lock:
        entry = _pending.get(request_id)
        if not entry:
            return False
        entry["approved"] = bool(approved)
        if approved and code is not None:
            entry["code"] = code
        entry["event"].set()
    return True


def _register_decision(request_id: str, code: str) -> dict:
    """登记待批项。必须在把 request_id 发给前端之前调用，否则答复可能先到而落空。"""
    entry = {"event": threading.Event(), "approved": False, "code": code}
    with _lock:
        _pending[request_id] = entry
    return entry


def _wait_for_decision(request_id: str, entry: dict) -> tuple[bool, str]:
    code = entry["code"]
    try:
        if not entry["event"].wait(DECISION_TIMEOUT_SECONDS):
            # 超时按拒绝处理：宁可让模型换个说法，也不能默认放行。
            return False, code
        return entry["approved"], entry["code"]
    finally:
        with _lock:
            _pending.pop(request_id, None)


# ---------- 子进程执行 ----------

def _truncate(raw: bytes) -> tuple[str, bool]:
    """按字节截断再解码：先解码再截字符的话，一个大输出会先整份进内存。"""
    clipped = len(raw) > MAX_OUTPUT_BYTES
    data = raw[:MAX_OUTPUT_BYTES] if clipped else raw
    return data.decode("utf-8", errors="replace"), clipped


def _child_command(script: Path) -> list[str]:
    """拼子进程命令行。开发态和打包态的「解释器」根本不是一个东西。"""
    if getattr(sys, "frozen", False):
        # 打包后 sys.executable 是 chatbot-backend.exe，直接塞 -I -S 只会让
        # 它的 argparse 报缺 --port。走 desktop_server.py 里的专用入口。
        return [sys.executable, "--run-script", str(script)]
    # -I 隔离模式（含 -s -E，不读用户 site-packages、不认 PYTHON* 环境变量），
    # -S 再关掉 site 初始化。不经 shell，参数按列表传，避免任何注入面。
    return [sys.executable, "-I", "-S", "-X", "utf8", str(script)]


def _child_env(workdir: Path) -> dict[str, str]:
    """只保留跑起来必需的变量，其余（含密钥）一律不传给子进程。"""
    env = {"SYSTEMROOT": _system_root(), "PYTHONIOENCODING": "utf-8"}
    if getattr(sys, "frozen", False):
        # onefile 的 bootloader 要有可写临时目录才能解包，没有 TEMP 时
        # GetTempPath 会退到 Windows 目录，普通用户写不进去，子进程直接起不来。
        # 指到这次执行的一次性目录里，跑完随目录一起删。
        env["TEMP"] = env["TMP"] = str(workdir)
    return env


def _kill_tree(proc: subprocess.Popen) -> None:
    """连子孙一起杀。

    打包态下我们启动的是 onefile 的 bootloader，真正跑代码的 Python 是它的
    子进程。只 kill 掉 bootloader 的话，孙子进程还攥着 stdout 管道不放，
    随后的 communicate() 会永久阻塞——超时保护反而变成了死等。
    """
    import os

    if os.name == "nt":
        root = _system_root()
        taskkill = os.path.join(root, "System32", "taskkill.exe") if root else "taskkill"
        try:
            subprocess.run(
                [taskkill, "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=10, check=False,
            )
        except Exception:
            pass
    proc.kill()


def run_subprocess(code: str) -> dict:
    """在一次性目录里跑代码。返回 stdout / stderr / 退出码 / 耗时。"""
    EXEC_DIR.mkdir(parents=True, exist_ok=True)
    workdir = EXEC_DIR / uuid.uuid4().hex
    workdir.mkdir()
    script = workdir / "main.py"
    script.write_text(code, encoding="utf-8")

    started = time.monotonic()
    timed_out = False
    proc = subprocess.Popen(
        _child_command(script),
        cwd=str(workdir),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_child_env(workdir),
        stdin=subprocess.DEVNULL,
    )
    try:
        raw_out, raw_err = proc.communicate(timeout=TIMEOUT_SECONDS)
        returncode = proc.returncode
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_tree(proc)
        # 进程树已经没了，这次 communicate 只是把管道里剩下的读完。
        try:
            raw_out, raw_err = proc.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            # 极端情况下还有句柄没释放，丢掉输出也不能让这一轮挂死。
            raw_out, raw_err = b"", b""
        returncode = None
    stdout, out_clipped = _truncate(raw_out or b"")
    stderr, err_clipped = _truncate(raw_err or b"")
    # 目录连同里面的产物一起删。删不掉不影响这次结果。
    shutil.rmtree(workdir, ignore_errors=True)

    return {
        "stdout": stdout,
        "stderr": stderr,
        "returncode": returncode,
        "timed_out": timed_out,
        "clipped": out_clipped or err_clipped,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


def _system_root() -> str:
    """Windows 上缺 SystemRoot 会让子进程起不来，其余平台给空串即可。"""
    import os

    return os.environ.get("SYSTEMROOT", "") or os.environ.get("SystemRoot", "")


def _format_result(result: dict) -> str:
    """回填给模型的文本。空输出要说明，否则模型会以为自己没看到结果。"""
    parts: list[str] = []
    if result["timed_out"]:
        parts.append(f"[执行超时，已终止：超过 {TIMEOUT_SECONDS} 秒]")
    if result["stdout"]:
        parts.append(f"标准输出：\n{result['stdout'].rstrip()}")
    if result["stderr"]:
        parts.append(f"错误输出：\n{result['stderr'].rstrip()}")
    if not result["stdout"] and not result["stderr"] and not result["timed_out"]:
        parts.append("[代码执行成功，但没有任何输出。结果需要用 print 打印出来。]")
    if result["clipped"]:
        parts.append(f"[输出过长已截断，仅保留前 {MAX_OUTPUT_BYTES // 1024}KB]")
    if result["returncode"] not in (0, None):
        parts.append(f"[退出码 {result['returncode']}]")
    return "\n\n".join(parts)


def run_tool(
    settings: dict, arguments: dict, context: dict | None = None
) -> Generator[dict, None, dict]:
    """三道闸依次过：总开关 → 静态检查 → 用户确认，然后才执行。"""
    context = context or {}
    code = (arguments.get("code") or "").strip()
    purpose = (arguments.get("purpose") or "").strip()
    conversation_id = context.get("conversation_id") or ""

    if not is_configured(settings):
        raise CodeRejected("代码执行功能未开启，用户需要先在设置里启用")

    # 静态检查放在确认框之前：不合规的代码不该浪费用户一次点击。
    modules = check_code(code)

    digest = hashlib.sha256(code.encode("utf-8")).hexdigest()[:16]
    # 默认只记元数据。代码原文属于对话内容，只在详细日志模式下留存。
    diag.log_event(
        "INFO", "backend", "代码执行请求", logger="backend.code_exec",
        conversation_id=conversation_id, code_sha256=digest, code_chars=len(code),
        modules=modules, code_preview=diag.verbose_preview(code),
    )

    approved = True
    if is_trusted(conversation_id):
        yield {"action": "code_exec_auto", "code": code, "purpose": purpose}
    else:
        request_id = uuid.uuid4().hex
        # 先登记再往外发：答复要是比这个生成器恢复得还快，落到空表上就等于没答。
        entry = _register_decision(request_id, code)
        try:
            # 前端据此弹确认框；这个生成器停在 wait 上，直到用户答复或超时。
            yield {
                "action": "code_exec_confirm",
                "request_id": request_id,
                "code": code,
                "purpose": purpose,
                "modules": modules,
                "conversation_id": conversation_id,
                "timeout_seconds": DECISION_TIMEOUT_SECONDS,
            }
            approved, code = _wait_for_decision(request_id, entry)
        finally:
            # 用户中止生成时生成器会在 yield 处被关掉，待批表不能留下孤儿项。
            with _lock:
                _pending.pop(request_id, None)

    if not approved:
        diag.log_event(
            "INFO", "backend", "代码执行被拒绝", logger="backend.code_exec",
            conversation_id=conversation_id, code_sha256=digest,
        )
        raise CodeRejected("用户拒绝了这次代码执行")

    # 用户可能改过代码，改后的版本必须重新过一遍静态检查。
    modules = check_code(code)
    yield {"action": "code_exec_running", "code": code}
    result = run_subprocess(code)

    diag.log_event(
        "INFO", "backend", "代码执行完成", logger="backend.code_exec",
        conversation_id=conversation_id, code_sha256=digest,
        returncode=result["returncode"], timed_out=result["timed_out"],
        elapsed_ms=result["elapsed_ms"], output_chars=len(result["stdout"]),
        stdout_preview=diag.verbose_preview(result["stdout"]),
    )

    return {
        "content": _format_result(result),
        "display": {
            "code": code,
            "stdout": result["stdout"],
            "stderr": result["stderr"],
            "timed_out": result["timed_out"],
            "elapsed_ms": result["elapsed_ms"],
            "returncode": result["returncode"],
        },
    }
