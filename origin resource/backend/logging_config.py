"""统一日志：可读文本与 JSONL 双写、脱敏、trace_id、内存环形缓冲。

三层日志（Electron 主进程、浏览器渲染进程、Python 后端）都汇总到这里，
由同一个写入器落盘，避免多进程同时写同一文件造成内容交错。

对外主要接口：
    setup_logging()          进程启动时调用一次，安装 handler 并接管 uvicorn
    get_logger(name)         取一个普通 logger，用法与 logging.getLogger 相同
    log_event(...)           写一条带结构化字段的日志
    ingest(entry)            接收前端 / Electron 上报的日志
    recent(...)             读取内存中的最近日志（供查询接口）
    subscribe()              订阅实时日志（供 SSE 推送）
"""
import json
import os
import re
import threading
import time
import traceback
import uuid
from collections import deque
from contextvars import ContextVar
from datetime import datetime, timedelta
from queue import Empty, Full, Queue
from typing import Any, Iterator

import logging

from paths import LOG_DIR


# ---------- 容量与保留策略 ----------

RETENTION_DAYS = 14
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_DIR_BYTES = 200 * 1024 * 1024
# 内存里保留的最近日志条数，供诊断面板首次加载和关键词搜索使用。
RING_CAPACITY = 3000
# 单个 SSE 订阅者的积压上限，超出即丢弃最旧的，避免慢客户端拖垮内存。
SUBSCRIBER_QUEUE_SIZE = 500

LEVEL_NAMES = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")


# ---------- trace_id ----------

_trace_id: ContextVar[str] = ContextVar("chatbot_trace_id", default="")


def new_trace_id() -> str:
    """生成一个短 trace_id；够短便于肉眼比对，也够长避免同一天内碰撞。"""
    return uuid.uuid4().hex[:12]


def bind_trace_id(value: str | None = None) -> str:
    """把 trace_id 绑定到当前上下文，返回最终生效的值。"""
    trace = (value or "").strip() or new_trace_id()
    _trace_id.set(trace)
    return trace


def current_trace_id() -> str:
    return _trace_id.get()


# ---------- 脱敏 ----------

_SECRET_KEY_NAMES = (
    "api_key", "apikey", "api-key", "authorization", "auth", "token",
    "access_token", "refresh_token", "secret", "password", "encryptedkey",
    "encrypted_key",
)

_REDACTIONS = (
    # sk-xxxx 形式的密钥，保留前 4 位便于确认用的是哪一把
    (re.compile(r"\b(sk-[A-Za-z0-9]{2})[A-Za-z0-9\-_]{6,}"), r"\1**已脱敏**"),
    # HTTP Authorization 头
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9\-._~+/]{8,}=*"), r"\1 **已脱敏**"),
    # key=value / "key": "value" 形式的敏感字段
    (
        re.compile(
            r"(?i)([\"']?(?:" + "|".join(_SECRET_KEY_NAMES) + r")[\"']?\s*[:=]\s*[\"']?)"
            r"([^\s,;&\"'}]{4,})"
        ),
        lambda m: m.group(1) + _mask(m.group(2)),
    ),
    # URL 里的 basic auth
    (re.compile(r"(?i)(https?://)[^/\s:@]+:[^/\s@]+@"), r"\1**已脱敏**@"),
)

_USER_DIR_PATTERN = re.compile(
    r"(?i)([A-Z]:\\Users\\|/Users/|/home/)([^\\/\s\"']+)"
)


def _mask(value: str) -> str:
    """密钥类值只保留前 4 位。"""
    text = str(value or "")
    if len(text) <= 4:
        return "**已脱敏**"
    return text[:4] + "**已脱敏**"


def mask_secret(value: str | None) -> str:
    return _mask(value or "") if value else ""


def redact(text: str) -> str:
    """对任意文本做脱敏。调试模式下仍会执行，密钥永不明文落盘。"""
    if not text:
        return text
    result = str(text)
    for pattern, replacement in _REDACTIONS:
        result = pattern.sub(replacement, result)
    # 路径里的 Windows 用户名同样属于个人信息，替换成占位符。
    result = _USER_DIR_PATTERN.sub(lambda m: f"{m.group(1)}<user>", result)
    return result


def redact_fields(fields: Any) -> Any:
    """递归脱敏结构化字段：敏感键名直接掩码，其余值按文本规则处理。"""
    if isinstance(fields, dict):
        cleaned = {}
        for key, value in fields.items():
            if str(key).lower() in _SECRET_KEY_NAMES:
                cleaned[key] = _mask(str(value)) if value else ""
            else:
                cleaned[key] = redact_fields(value)
        return cleaned
    if isinstance(fields, (list, tuple)):
        return [redact_fields(item) for item in fields]
    if isinstance(fields, str):
        return redact(fields)
    return fields


# ---------- 调试模式 ----------

_verbose = False


def set_verbose(enabled: bool) -> bool:
    """调试模式：记录 DEBUG 级别与请求 / 响应正文摘要。"""
    global _verbose
    _verbose = bool(enabled)
    logging.getLogger().setLevel(logging.DEBUG if _verbose else logging.INFO)
    log_event(
        "INFO", "backend", "详细日志已" + ("开启" if _verbose else "关闭"),
        logger="backend.diagnostics", verbose=_verbose,
    )
    return _verbose


def is_verbose() -> bool:
    return _verbose


def verbose_preview(value: Any, limit: int = 2000) -> str | None:
    """调试模式下截取正文摘要；非调试模式返回 None，调用方据此跳过记录。"""
    if not _verbose:
        return None
    if not isinstance(value, str):
        try:
            value = json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            value = str(value)
    text = redact(value)
    return text if len(text) <= limit else text[:limit] + f"…（共 {len(text)} 字，已截断）"


# ---------- 落盘：按天 + 按体积轮转，双份格式 ----------

class LogWriter:
    """把日志同时写成可读文本与 JSONL 两份，并负责轮转和清理。

    可读文本给人看，JSONL 给 AI 与脚本解析。两份文件同名不同扩展名，
    一一对应，导出诊断包时一起带走。
    """

    def __init__(self, directory=LOG_DIR):
        self._dir = directory
        self._lock = threading.RLock()
        self._day = ""
        self._text = None
        self._jsonl = None
        self._cleanup_day = ""

    # -- 文件句柄管理 --

    def _paths(self, day: str, index: int) -> tuple:
        suffix = "" if index == 0 else f".{index}"
        return (
            self._dir / f"app-{day}{suffix}.log",
            self._dir / f"app-{day}{suffix}.jsonl",
        )

    def _open_day(self, day: str) -> None:
        """打开当天的日志文件；若已存在且超过体积上限则顺延到下一个分片。"""
        self._dir.mkdir(parents=True, exist_ok=True)
        index = 0
        while True:
            text_path, jsonl_path = self._paths(day, index)
            text_size = text_path.stat().st_size if text_path.exists() else 0
            jsonl_size = jsonl_path.stat().st_size if jsonl_path.exists() else 0
            if max(text_size, jsonl_size) < MAX_FILE_BYTES:
                break
            index += 1
        self._close()
        self._text = open(text_path, "a", encoding="utf-8", newline="\n")
        self._jsonl = open(jsonl_path, "a", encoding="utf-8", newline="\n")
        self._day = day

    def _close(self) -> None:
        for handle in (self._text, self._jsonl):
            try:
                if handle:
                    handle.close()
            except OSError:
                pass
        self._text = None
        self._jsonl = None

    def _ensure_open(self, day: str) -> None:
        if self._text is None or self._jsonl is None or self._day != day:
            self._open_day(day)
            if self._cleanup_day != day:
                self._cleanup_day = day
                self._cleanup()
            return
        # 同一天内写满 10MB 就切到下一个分片。
        if self._text.tell() >= MAX_FILE_BYTES or self._jsonl.tell() >= MAX_FILE_BYTES:
            self._open_day(day)

    # -- 保留策略 --

    def _cleanup(self) -> None:
        """先按天数删除过期文件，再按目录总体积从最旧开始删除。"""
        try:
            files = sorted(
                (path for path in self._dir.glob("app-*.*") if path.suffix in (".log", ".jsonl")),
                key=lambda path: path.stat().st_mtime,
            )
        except OSError:
            return

        deadline = datetime.now() - timedelta(days=RETENTION_DAYS)
        keep = []
        for path in files:
            try:
                if datetime.fromtimestamp(path.stat().st_mtime) < deadline:
                    path.unlink()
                else:
                    keep.append(path)
            except OSError:
                keep.append(path)

        try:
            total = sum(path.stat().st_size for path in keep)
        except OSError:
            return
        for path in keep:
            if total <= MAX_DIR_BYTES:
                break
            # 当前正在写入的文件不删，否则句柄会指向已删除的 inode。
            if self._text and path.samefile(self._text.name):
                continue
            try:
                size = path.stat().st_size
                path.unlink()
                total -= size
            except OSError:
                continue

    # -- 写入 --

    def write(self, record: dict, flush: bool = False) -> None:
        day = record["ts"][:10]
        with self._lock:
            try:
                self._ensure_open(day)
                self._text.write(_format_readable(record) + "\n")
                self._jsonl.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
                if flush:
                    self._text.flush()
                    self._jsonl.flush()
                    os.fsync(self._text.fileno())
                    os.fsync(self._jsonl.fileno())
            except OSError:
                # 磁盘写不进去时不能让业务崩掉，日志本身失败只能放弃这一条。
                self._close()

    def flush(self) -> None:
        with self._lock:
            for handle in (self._text, self._jsonl):
                try:
                    if handle:
                        handle.flush()
                        os.fsync(handle.fileno())
                except OSError:
                    pass

    def close(self) -> None:
        with self._lock:
            self.flush()
            self._close()

    def log_files(self, days: int = RETENTION_DAYS) -> list:
        """列出保留期内的日志文件，供诊断包打包与日志查询使用。"""
        deadline = datetime.now() - timedelta(days=days)
        try:
            paths = [
                path for path in self._dir.glob("app-*.*")
                if path.suffix in (".log", ".jsonl")
                and datetime.fromtimestamp(path.stat().st_mtime) >= deadline
            ]
        except OSError:
            return []
        return sorted(paths, key=lambda path: (path.name, path.suffix))


def _format_readable(record: dict) -> str:
    """单行可读格式：时间、级别、来源、消息，尾部附加结构化字段。"""
    head = (
        f"[{record['ts']}] [{record['level']:<7}] "
        f"[{record.get('logger') or record.get('source') or '-'}]"
    )
    trace = record.get("trace_id")
    parts = [head, record.get("message") or ""]
    if trace:
        parts.append(f"trace={trace}")
    fields = record.get("fields") or {}
    if fields:
        parts.append(json.dumps(fields, ensure_ascii=False, default=str))
    line = " ".join(part for part in parts if part)
    if record.get("stack"):
        line += "\n" + record["stack"].rstrip()
    return line


# ---------- 内存缓冲与实时订阅 ----------

_writer = LogWriter()
_ring: deque = deque(maxlen=RING_CAPACITY)
_ring_lock = threading.RLock()
_subscribers: set = set()
_subscribers_lock = threading.RLock()
_sequence = 0


def _next_sequence() -> int:
    global _sequence
    _sequence += 1
    return _sequence


def _publish(record: dict) -> None:
    with _ring_lock:
        _ring.append(record)
    with _subscribers_lock:
        targets = list(_subscribers)
    for queue in targets:
        try:
            queue.put_nowait(record)
        except Full:
            # 慢客户端只丢最旧的一条，保证它仍能看到最新日志。
            try:
                queue.get_nowait()
                queue.put_nowait(record)
            except (Empty, Full):
                pass


def subscribe() -> Queue:
    queue: Queue = Queue(maxsize=SUBSCRIBER_QUEUE_SIZE)
    with _subscribers_lock:
        _subscribers.add(queue)
    return queue


def unsubscribe(queue: Queue) -> None:
    with _subscribers_lock:
        _subscribers.discard(queue)


def recent(
    limit: int = 500,
    levels: list | None = None,
    sources: list | None = None,
    keyword: str = "",
    after_seq: int | None = None,
    trace_id: str | None = None,
) -> list:
    """按条件读取内存中的最近日志。诊断面板首次加载与搜索都走这里。"""
    with _ring_lock:
        items = list(_ring)
    wanted_levels = {str(item).upper() for item in levels} if levels else None
    wanted_sources = {str(item) for item in sources} if sources else None
    needle = keyword.strip().lower()

    result = []
    for record in items:
        if after_seq is not None and record["seq"] <= after_seq:
            continue
        if wanted_levels and record["level"] not in wanted_levels:
            continue
        if wanted_sources and record["source"] not in wanted_sources:
            continue
        if trace_id and record.get("trace_id") != trace_id:
            continue
        if needle:
            haystack = _format_readable(record).lower()
            if needle not in haystack:
                continue
        result.append(record)
    return result[-limit:] if limit > 0 else result


def log_dir():
    return LOG_DIR


def log_files(days: int = RETENTION_DAYS) -> list:
    return _writer.log_files(days)


def flush() -> None:
    _writer.flush()


# ---------- 写日志的统一入口 ----------

def _build_record(
    level: str,
    source: str,
    message: str,
    logger: str = "",
    trace_id: str | None = None,
    stack: str | None = None,
    ts: str | None = None,
    **fields: Any,
) -> dict:
    return {
        "seq": _next_sequence(),
        "ts": ts or datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
        "level": str(level or "INFO").upper(),
        "source": source or "backend",
        "logger": logger or "",
        "message": redact(str(message or "")),
        "trace_id": trace_id if trace_id is not None else current_trace_id(),
        "fields": redact_fields(fields) if fields else {},
        "stack": redact(stack) if stack else None,
    }


def log_event(
    level: str,
    source: str,
    message: str,
    logger: str = "",
    trace_id: str | None = None,
    stack: str | None = None,
    ts: str | None = None,
    **fields: Any,
) -> dict:
    """写一条结构化日志。崩溃类日志（ERROR 及以上）强制同步落盘。"""
    record = _build_record(
        level, source, message,
        logger=logger, trace_id=trace_id, stack=stack, ts=ts, **fields,
    )
    if record["level"] == "DEBUG" and not _verbose:
        return record
    _writer.write(record, flush=record["level"] in ("ERROR", "CRITICAL"))
    _publish(record)
    return record


_VALID_SOURCES = ("backend", "frontend", "electron")

# 外部进程习惯用 WARN / FATAL，统一到标准库的名字，否则会被当成未知级别丢成 INFO。
_LEVEL_ALIASES = {"WARN": "WARNING", "FATAL": "CRITICAL", "ERR": "ERROR", "TRACE": "DEBUG"}


def _normalize_ts(value: Any) -> str | None:
    """把 ISO 8601（含 Z 后缀）统一成本地日志用的 'YYYY-MM-DD HH:MM:SS.mmm'。

    时间戳的日期部分决定写进哪一天的文件，格式不统一会让文件名错乱。
    """
    text = str(value or "").strip()
    if not text:
        return None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is not None:
        moment = moment.astimezone().replace(tzinfo=None)
    return moment.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def ingest(entry: dict) -> dict:
    """接收前端 / Electron 上报的日志，与后端日志走同一条落盘路径。"""
    source = str(entry.get("source") or "frontend")
    if source not in _VALID_SOURCES:
        source = "frontend"
    level = str(entry.get("level") or "INFO").upper()
    level = _LEVEL_ALIASES.get(level, level)
    if level not in LEVEL_NAMES:
        level = "INFO"
    fields = entry.get("fields")
    if not isinstance(fields, dict):
        fields = {} if fields is None else {"value": fields}
    return log_event(
        level,
        source,
        str(entry.get("message") or ""),
        # module 是 Electron / 前端那侧的叫法，落盘时统一成 logger。
        logger=str(entry.get("logger") or entry.get("module") or source),
        trace_id=str(entry.get("trace_id") or "") or None,
        stack=entry.get("stack") or None,
        ts=_normalize_ts(entry.get("ts") or entry.get("timestamp")),
        **fields,
    )


# ---------- 与标准库 logging 对接 ----------

class DiagnosticsHandler(logging.Handler):
    """把标准库的 LogRecord 转换成统一记录格式。

    这样第三方库（uvicorn、httpx、openai）的日志也会进入同一份文件，
    排查问题时不必再去翻别处。
    """

    def emit(self, record: logging.LogRecord) -> None:
        try:
            stack = None
            if record.exc_info:
                stack = "".join(traceback.format_exception(*record.exc_info))
            fields = getattr(record, "fields", None)
            if not isinstance(fields, dict):
                fields = {}
            log_event(
                record.levelname,
                getattr(record, "source", "backend"),
                record.getMessage(),
                logger=record.name,
                trace_id=getattr(record, "trace_id", None),
                stack=stack,
                **fields,
            )
        except Exception:  # noqa: BLE001 - 日志失败不能反过来打断业务
            pass


def get_logger(name: str) -> logging.Logger:
    """业务模块统一从这里取 logger，命名约定为 backend.<模块>。"""
    return logging.getLogger(name if name.startswith("backend") else f"backend.{name}")


class _TraceIdFilter(logging.Filter):
    """给没有显式携带 trace_id 的记录补上当前上下文的值。"""

    def filter(self, record: logging.LogRecord) -> bool:
        if not getattr(record, "trace_id", None):
            record.trace_id = current_trace_id()
        return True


_configured = False


def setup_logging(verbose: bool = False) -> None:
    """安装日志处理器并接管第三方库的输出。进程内只需调用一次。"""
    global _configured, _verbose
    if _configured:
        set_verbose(verbose)
        return

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    _verbose = bool(verbose)

    handler = DiagnosticsHandler()
    handler.addFilter(_TraceIdFilter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.DEBUG if _verbose else logging.INFO)

    # uvicorn 默认会自己往 stdout 打一份，这里让它只走我们的 handler，
    # 避免同一条访问日志出现两次。
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "openai", "httpx", "httpcore"):
        logger = logging.getLogger(name)
        logger.handlers = []
        logger.propagate = True
    # HTTP 客户端库在 DEBUG 下会输出请求头，噪音极大且含密钥，始终压到 WARNING。
    for name in ("httpx", "httpcore", "openai._base_client"):
        logging.getLogger(name).setLevel(logging.WARNING)

    _configured = True
    log_event(
        "INFO", "backend", "后端日志已启动",
        logger="backend.diagnostics",
        log_dir=str(LOG_DIR), verbose=_verbose, pid=os.getpid(),
    )


def log_exception(logger_name: str, message: str, error: BaseException, **fields: Any) -> None:
    """记录一次异常，带完整堆栈。异常路径统一调用这个函数。"""
    log_event(
        "ERROR", "backend", f"{message}：{error}",
        logger=logger_name if logger_name.startswith("backend") else f"backend.{logger_name}",
        stack="".join(traceback.format_exception(type(error), error, error.__traceback__)),
        error_type=type(error).__name__,
        **fields,
    )


class Timer:
    """测量一段逻辑的耗时，单位毫秒。用于给日志补上 elapsed 字段。"""

    def __init__(self):
        self._start = time.perf_counter()

    def elapsed_ms(self) -> int:
        return int((time.perf_counter() - self._start) * 1000)


def iter_log_lines(paths: list, limit: int = 5000) -> Iterator[str]:
    """按顺序读取日志文件的最后若干行，供导出与「复制最近日志」使用。"""
    buffer: deque = deque(maxlen=limit)
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    buffer.append(line.rstrip("\n"))
        except OSError:
            continue
    return iter(buffer)



