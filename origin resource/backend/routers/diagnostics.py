"""诊断接口：日志查询、实时流、诊断包导出、崩溃上报。

前端与 Electron 主进程的日志都经 /api/diagnostics/ingest 汇总到这里，
由后端单一写入器落盘，避免多进程同时写同一文件。
"""
import json
import os
import platform
import shutil
import sys
import time
import zipfile
from datetime import datetime
from io import BytesIO
from queue import Empty

from fastapi import APIRouter, Body, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

import database as db
import logging_config as diag
from paths import DATA_DIR


router = APIRouter(prefix="/api/diagnostics", tags=["diagnostics"])

APP_VERSION = os.environ.get("CHATBOT_APP_VERSION", "unknown")


class LogEntry(BaseModel):
    """外部进程（Electron / 前端）上报的一条日志。"""

    level: str = "INFO"
    source: str = "frontend"
    message: str = ""
    # Electron 侧叫 module，浏览器侧叫 logger，两个都收，落盘时归一到 logger。
    logger: str | None = None
    module: str | None = None
    trace_id: str | None = None
    # 后端自己用 ts，外部进程习惯 timestamp（ISO 8601），两种都接。
    ts: str | None = None
    timestamp: str | None = None
    stack: str | None = None
    fields: dict | None = None


@router.post("/ingest")
def ingest_logs(entries: list[LogEntry] = Body(...)):
    """批量接收外部日志。前端按批上报以减少请求数。"""
    written = 0
    for entry in entries:
        diag.ingest(entry.model_dump())
        written += 1
    return {"written": written}


@router.get("/logs")
def query_logs(
    limit: int = Query(500, ge=1, le=5000),
    level: str | None = None,
    source: str | None = None,
    search: str | None = None,
    trace_id: str | None = None,
):
    """按条件倒序返回最近日志，供面板查看与过滤。"""
    levels = [item.strip().upper() for item in level.split(",")] if level else None
    sources = [item.strip() for item in source.split(",")] if source else None
    records = diag.recent(
        limit=limit, levels=levels, sources=sources,
        keyword=search or "", trace_id=trace_id,
    )
    return {"records": records, "count": len(records), "verbose": diag.is_verbose()}


@router.get("/stream")
def stream_logs(level: str | None = None, source: str | None = None):
    """SSE 实时日志流。心跳每 15 秒一次，防止代理断开空闲连接。"""
    levels = {item.strip().upper() for item in level.split(",")} if level else None
    sources = {item.strip() for item in source.split(",")} if source else None

    def event_stream():
        queue = diag.subscribe()
        try:
            yield "retry: 3000\n\n"
            last_beat = time.monotonic()
            while True:
                try:
                    record = queue.get(timeout=1.0)
                except Empty:
                    if time.monotonic() - last_beat >= 15:
                        last_beat = time.monotonic()
                        yield ": keep-alive\n\n"
                    continue
                if levels and record.get("level") not in levels:
                    continue
                if sources and record.get("source") not in sources:
                    continue
                yield f"data: {json.dumps(record, ensure_ascii=False)}\n\n"
        finally:
            # 客户端断开时必须退订，否则队列会一直堆积造成内存泄漏。
            diag.unsubscribe(queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/verbose")
def get_verbose():
    return {"verbose": diag.is_verbose()}


@router.put("/verbose")
def put_verbose(payload: dict = Body(...)):
    """切换调试模式。同时落库，重启后保持。"""
    enabled = bool(payload.get("enabled"))
    diag.set_verbose(enabled)
    db.save_settings({"verbose_logging": enabled})
    return {"verbose": enabled}


@router.get("/info")
def system_info():
    """系统与运行环境信息，诊断包和界面都用它。"""
    return _collect_info()


@router.get("/log-dir")
def get_log_dir():
    return {"path": str(diag.log_dir())}


def _collect_info() -> dict:
    try:
        usage = shutil.disk_usage(str(DATA_DIR))
        disk = {
            "total_gb": round(usage.total / 1024 ** 3, 1),
            "free_gb": round(usage.free / 1024 ** 3, 1),
        }
    except OSError:
        disk = {}
    files = diag.log_files()
    return {
        "app_version": APP_VERSION,
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "arch": platform.machine(),
        "cpu_count": os.cpu_count(),
        "data_dir": diag.redact(str(DATA_DIR)),
        "log_dir": diag.redact(str(diag.log_dir())),
        "verbose_logging": diag.is_verbose(),
        "log_files": len(files),
        "log_bytes": sum(path.stat().st_size for path in files if path.exists()),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }


BUNDLE_README = """AI Chatbot 诊断包
==================

生成时间：{generated_at}
应用版本：{app_version}

文件说明
--------
logs/app-*.log     人类可读日志，一行一条：[时间] [级别] [模块] 消息 key=value
logs/app-*.jsonl   同样内容的结构化版本，一行一个 JSON 对象，适合脚本或 AI 解析
system-info.json   操作系统、Python 版本、磁盘余量、日志体积等运行环境信息
settings.json      应用配置，API Key 等密钥已脱敏（只保留前 4 位）
crashes.json       历史崩溃记录：主进程异常、渲染进程崩溃、后端子进程非正常退出

怎么定位问题
------------
1. 在 .jsonl 里筛 "level":"ERROR"，先看最早的一条，后面的常是它的连带反应。
2. 拿到该条的 trace_id，用它筛出同一次请求的全部日志，即可看到
   「用户操作 -> 前端请求 -> 后端处理 -> 报错点」的完整链路。
3. source 字段区分来源：electron（主进程）、frontend（界面）、backend（服务端）。
4. 崩溃类问题先看 crashes.json，再回到对应时间点的日志。

隐私说明
--------
默认不记录对话内容，仅记录条数、字符数、模型名、耗时等元数据。
{verbose_note}
"""

VERBOSE_WARNING = (
    "注意：本诊断包覆盖的时间段内曾开启「详细日志」，日志中可能含有完整的\n"
    "请求与响应正文（包括对话内容）。分享前请自行确认。"
)

VERBOSE_CLEAN = "本次日志未开启详细模式，不含对话正文。"


@router.get("/bundle")
def export_bundle(days: int = Query(3, ge=1, le=14)):
    """把日志、环境信息、脱敏配置打成一个 zip，可直接交给 AI 分析。"""
    diag.flush()
    info = _collect_info()
    buffer = BytesIO()
    verbose_seen = diag.is_verbose()
    files = diag.log_files(days=days)

    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in files:
            if not path.exists():
                continue
            try:
                bundle.write(path, f"logs/{path.name}")
            except OSError as error:
                bundle.writestr(f"logs/{path.name}.error.txt", f"读取失败：{error}")
        if _verbose_marker_in(files):
            verbose_seen = True

        bundle.writestr("system-info.json", json.dumps(info, ensure_ascii=False, indent=2))
        bundle.writestr(
            "settings.json", json.dumps(_safe_settings(), ensure_ascii=False, indent=2)
        )
        bundle.writestr(
            "crashes.json", json.dumps(_read_crashes(), ensure_ascii=False, indent=2)
        )
        bundle.writestr(
            "README.txt",
            BUNDLE_README.format(
                generated_at=info["generated_at"],
                app_version=info["app_version"],
                verbose_note=VERBOSE_WARNING if verbose_seen else VERBOSE_CLEAN,
            ),
        )

    payload = buffer.getvalue()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    diag.log_event(
        "INFO", "backend", "已导出诊断包", logger="backend.diagnostics",
        files=len(files), size_bytes=len(payload), contains_verbose=verbose_seen,
    )
    return StreamingResponse(
        BytesIO(payload),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="chatbot-diagnostics-{stamp}.zip"',
            "X-Contains-Sensitive": "1" if verbose_seen else "0",
        },
    )


def _verbose_marker_in(files: list) -> bool:
    """扫描日志判断这段时间是否开过详细模式，用于导出时二次提醒。"""
    for path in files:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    if "verbose" in line and "true" in line.lower():
                        return True
        except OSError:
            continue
    return False


SECRET_KEYS = ("api_key", "token", "secret", "password")


def _safe_settings() -> dict:
    """配置脱敏：密钥类字段只留前 4 位，长文本只留长度。"""
    try:
        settings = db.get_settings()
    except Exception as error:  # noqa: BLE001 - 诊断包不能因为读配置失败而生成不出来
        return {"_error": f"读取设置失败：{error}"}
    safe = {}
    for key, value in settings.items():
        if any(marker in key for marker in SECRET_KEYS):
            safe[key] = diag.mask_secret(value if isinstance(value, str) else None)
        elif key == "system_prompt" and isinstance(value, str):
            safe[key] = f"<{len(value)} 字符，已省略>"
        elif isinstance(value, str):
            safe[key] = diag.redact(value)
        else:
            safe[key] = value
    return safe


CRASH_FILE = DATA_DIR / "crashes.json"
MAX_CRASHES = 50


def _read_crashes() -> list:
    if not CRASH_FILE.exists():
        return []
    try:
        data = json.loads(CRASH_FILE.read_text(encoding="utf-8") or "[]")
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


@router.get("/crashes")
def list_crashes():
    return {"crashes": _read_crashes()}


@router.post("/crashes")
def record_crash(payload: dict = Body(...)):
    """记录一次崩溃。Electron 主进程在捕获到异常时调用。"""
    entry = {
        "at": datetime.now().isoformat(timespec="seconds"),
        "kind": str(payload.get("kind", "unknown"))[:64],
        "source": str(payload.get("source", "electron"))[:32],
        "message": diag.redact(str(payload.get("message", ""))[:2000]),
        "stack": diag.redact(str(payload.get("stack", ""))[:8000]),
        "details": diag.redact_fields(payload.get("details") or {}),
        "app_version": APP_VERSION,
    }
    crashes = _read_crashes()
    crashes.append(entry)
    try:
        CRASH_FILE.write_text(
            json.dumps(crashes[-MAX_CRASHES:], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError as error:
        return JSONResponse({"saved": False, "error": str(error)}, status_code=500)
    diag.log_event(
        "CRITICAL", entry["source"], f"崩溃记录：{entry['kind']} {entry['message']}",
        logger="diagnostics.crash", stack=entry["stack"] or None,
    )
    diag.flush()
    return {"saved": True, "total": len(crashes)}


@router.delete("/crashes")
def clear_crashes():
    try:
        CRASH_FILE.unlink(missing_ok=True)
    except OSError as error:
        return JSONResponse({"cleared": False, "error": str(error)}, status_code=500)
    return {"cleared": True}
