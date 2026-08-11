"""FastAPI 应用入口。

这个文件只负责把应用“组装”起来。具体接口位于 routers/，业务和数据处理
分别位于 llm.py、files.py、images.py 与 database.py。
"""
from contextlib import asynccontextmanager
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import database as db
import logging_config as diag
from paths import FRONTEND_DIST, ensure_data_dirs
from routers import ALL_ROUTERS


# 优先读取项目根目录的 .env，同时兼容旧版放在上一级目录的配置。
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(PROJECT_ROOT.parent / ".env")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """服务启动时准备日志与数据库，并在首次运行时导入环境变量配置。"""
    ensure_data_dirs()
    db.init_db()
    settings = db.get_settings()
    # 日志必须在读到设置之后才知道要不要开调试模式，因此放在 init_db 之后。
    diag.setup_logging(bool(settings.get("verbose_logging")))
    if not settings.get("api_key") and os.getenv("OPENAI_API_KEY"):
        db.save_settings({
            "api_key": os.getenv("OPENAI_API_KEY"),
            "base_url": os.getenv("OPENAI_BASE_URL", ""),
        })
    diag.log_event(
        "INFO", "backend", "后端服务已就绪",
        logger="backend.lifespan",
        data_dir=str(diag.log_dir().parent),
        default_model=settings.get("default_model"),
    )
    try:
        yield
    finally:
        diag.log_event("INFO", "backend", "后端服务正在退出", logger="backend.lifespan")
        diag.flush()


def create_app() -> FastAPI:
    """创建应用实例；测试代码也可以调用此函数获得一个全新的应用。"""
    application = FastAPI(title="Claude 风格聊天后端", lifespan=lifespan)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @application.middleware("http")
    async def log_requests(request: Request, call_next):
        """给每个请求绑定 trace_id 并记录结果，异常一律留下完整堆栈。

        trace_id 优先取前端传来的 X-Trace-Id，这样同一次用户操作在前端日志
        和后端日志里是同一个编号，可以直接串起来看。
        """
        trace_id = diag.bind_trace_id(request.headers.get("X-Trace-Id"))
        timer = diag.Timer()
        path = request.url.path
        # 日志接口自身会被诊断面板高频轮询，记录它只会淹没真正有用的日志。
        quiet = path.startswith("/api/diagnostics/logs") or path == "/api/health"

        if not quiet:
            diag.log_event(
                "DEBUG", "backend", f"收到请求 {request.method} {path}",
                logger="backend.request",
                query=str(request.url.query) or None,
                client=request.client.host if request.client else None,
            )
        try:
            response = await call_next(request)
        except Exception as error:  # noqa: BLE001 - 统一记录后交给 FastAPI 处理
            diag.log_exception(
                "backend.request", f"请求处理异常 {request.method} {path}", error,
                method=request.method, path=path, elapsed_ms=timer.elapsed_ms(),
            )
            return JSONResponse(
                {"detail": "服务器内部错误，详情见诊断日志", "trace_id": trace_id},
                status_code=500,
                headers={"X-Trace-Id": trace_id},
            )

        response.headers["X-Trace-Id"] = trace_id
        if not quiet:
            status = response.status_code
            diag.log_event(
                "WARNING" if status >= 400 else "INFO", "backend",
                f"{request.method} {path} -> {status}",
                logger="backend.request",
                status=status, elapsed_ms=timer.elapsed_ms(),
            )
        return response

    for router in ALL_ROUTERS:
        application.include_router(router)

    @application.get("/api/health")
    def health():
        """桌面端启动时用来轮询后端是否就绪。"""
        return {"ok": True}

    if (FRONTEND_DIST / "index.html").is_file():
        application.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
    return application


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8010, use_colors=False)
