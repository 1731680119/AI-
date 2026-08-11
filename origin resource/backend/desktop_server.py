"""Packaged desktop backend entry point."""
import sys


def _run_user_script(path: str) -> None:
    """代码执行工具的子进程入口。

    打包后没有独立的 python.exe，sys.executable 就是本体，只能拿本体当解释器
    使。这个分支必须在导入 uvicorn / main 之前判定：子进程只跑用户那一段代码，
    既不能起服务，也没必要为此加载整个后端。
    """
    import runpy
    import traceback

    sys.argv = [path]
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    try:
        runpy.run_path(path, run_name="__main__")
    except SystemExit:
        raise
    except BaseException as error:
        # 报错要看着像直接跑 python main.py 的结果：runpy 和本文件的栈帧对
        # 读日志的人和模型都是噪音，掐掉最外面两层再打印。
        tb = error.__traceback__
        for _ in range(2):
            if tb is not None and tb.tb_next is not None:
                tb = tb.tb_next
        traceback.print_exception(type(error), error, tb)
        raise SystemExit(1) from None


if __name__ == "__main__" and len(sys.argv) >= 3 and sys.argv[1] == "--run-script":
    _run_user_script(sys.argv[2])
    raise SystemExit(0)

import argparse  # noqa: E402  上面的子进程分支必须先于这些导入判定

import uvicorn  # noqa: E402

from main import app  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
