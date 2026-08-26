"""SQLite 数据库层：会话、消息树（支持分支）、设置"""
import json
import sqlite3
import uuid
from datetime import datetime
from contextlib import contextmanager

import logging_config as diag
from paths import DATABASE_PATH


DB_PATH = str(DATABASE_PATH)


def now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@contextmanager
def get_db():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except sqlite3.Error as error:
        # 数据库锁、约束冲突、磁盘满都会走到这里，是数据类 bug 的主要线索。
        conn.rollback()
        diag.log_exception("backend.database", "数据库操作失败", error, db_path=DB_PATH)
        raise
    finally:
        conn.close()


def init_db():
    with get_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '新对话',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                active_leaf_id TEXT,
                pinned INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                parent_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                thinking TEXT,
                model TEXT,
                attachments TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
            CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS images (
                id TEXT PRIMARY KEY,
                mode TEXT NOT NULL DEFAULT 'generate',
                prompt TEXT NOT NULL DEFAULT '',
                negative_prompt TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                size TEXT NOT NULL DEFAULT '',
                quality TEXT NOT NULL DEFAULT '',
                source_image_name TEXT NOT NULL DEFAULT '',
                files TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '新项目',
                description TEXT NOT NULL DEFAULT '',
                instructions TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                source_conversation_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS context_summaries (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                covered_until_message_id TEXT NOT NULL,
                summary TEXT NOT NULL,
                original_chars INTEGER NOT NULL DEFAULT 0,
                summary_chars INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_context_summaries_conv
                ON context_summaries(conversation_id);
            """
        )
        image_columns = {row["name"] for row in db.execute("PRAGMA table_info(images)")}
        if "reference_names" not in image_columns:
            db.execute(
                "ALTER TABLE images ADD COLUMN reference_names TEXT NOT NULL DEFAULT '[]'"
            )
        if "reference_notes" not in image_columns:
            db.execute(
                "ALTER TABLE images ADD COLUMN reference_notes TEXT NOT NULL DEFAULT '[]'"
            )
        conv_columns = {row["name"] for row in db.execute("PRAGMA table_info(conversations)")}
        if "project_id" not in conv_columns:
            # 不加外键约束：SQLite 的 ALTER TABLE 无法追加带级联的外键，
            # 删除项目时由 delete_project 显式把归属清空。
            db.execute("ALTER TABLE conversations ADD COLUMN project_id TEXT")
        if "style_id" not in conv_columns:
            # 风格存 id 而不是正文，改了风格定义之后旧会话会跟着变，符合直觉。
            db.execute("ALTER TABLE conversations ADD COLUMN style_id TEXT")
        if "memory_enabled" not in conv_columns:
            # 记忆是每个会话自己决定要不要带上的，默认 0（关）：新对话一律从
            # 「不带记忆」开始，需要时由用户在输入框上手动打开。
            db.execute(
                "ALTER TABLE conversations "
                "ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 0"
            )
        if "memory_ids" not in conv_columns:
            # 勾选了哪几条记忆，存 id 的 JSON 数组。存 id 不存正文：记忆改了
            # 措辞之后这个会话跟着变，和 style_id 的取舍一致。
            db.execute("ALTER TABLE conversations ADD COLUMN memory_ids TEXT")
        message_columns = {row["name"] for row in db.execute("PRAGMA table_info(messages)")}
        if "tool_calls" not in message_columns:
            # 存工具调用的原始 JSON：既用于重开对话时还原工具卡片，也为将来把
            # web_search_call 原样回传给上游留出位置（Responses API 要求如此）。
            db.execute("ALTER TABLE messages ADD COLUMN tool_calls TEXT")


# ---------- 设置 ----------

# 内置风格。builtin 的条目允许改 prompt，但不允许删除，删掉会导致老会话
# 指向一个不存在的 id。normal 的 prompt 恒为空，代表「不追加任何风格指令」。
BUILTIN_STYLES = [
    {"id": "normal", "name": "正常", "prompt": "", "builtin": True},
    {
        "id": "concise",
        "name": "简洁",
        "prompt": "回答尽量简短直接，去掉铺垫和总结性的收尾，只给结论和必要的依据。",
        "builtin": True,
    },
    {
        "id": "explanatory",
        "name": "讲解",
        "prompt": "像教学一样作答：解释为什么这样做，指出背后的原理和常见误区，必要时给类比。",
        "builtin": True,
    },
    {
        "id": "formal",
        "name": "正式",
        "prompt": "使用书面、正式的措辞，结构清晰，避免口语化表达和表情符号。",
        "builtin": True,
    },
]

DEFAULT_PROMPT_TEMPLATES = [
    {
        "id": "explain-code",
        "name": "解释代码",
        "content": "解释下面这段代码的作用、关键实现和可能的坑：\n\n{{input}}",
    },
    {
        "id": "polish",
        "name": "润色文字",
        "content": "在不改变原意的前提下润色下面这段文字，让它更通顺自然：\n\n{{input}}",
    },
    {
        "id": "summarize",
        "name": "提炼要点",
        "content": "把下面的内容提炼成不超过 5 条要点：\n\n{{input}}",
    },
]

DEFAULT_SEARCH_PROVIDERS = [
    {
        "id": "default",
        "name": "DeepSeek 官方",
        "base_url": "https://api.deepseek.com",
        "api_key": "",
        "model": "deepseek-v4-flash",
        # 搜索结果由服务端塞进上下文，一次联网问答的输入量是普通对话的十几倍，
        # 这里给单次搜索的输出留一个可调的预算。
        "max_output_tokens": 4000,
    },
]

DEFAULT_SETTINGS = {
    "base_url": "",
    "api_key": "",
    "models": ["claude-sonnet-4-5", "claude-opus-4-6"],
    "default_model": "claude-sonnet-4-5",
    "system_prompt": "",
    "temperature": 1.0,
    "max_tokens": 8192,
    # ---- 思考档位 ----
    # auto 表示不发这个参数，完全按上游模型自己的默认行为；其余档位会带上
    # reasoning_effort。不是所有上游都认这个参数，所以默认保持 auto。
    "default_thinking": "auto",
    "theme": "light",
    # 图片渠道和桌面端「多 API」一样存成有序列表：从上往下找第一个能用的，
    # 失败了再试下一个。下面三个平铺字段是「当前生效渠道」的镜像，由
    # _mirror_active_image_provider 维护，读的地方不用关心列表。
    "image_providers": [],
    "image_base_url": "",
    "image_api_key": "",
    "image_model": "gpt-image-2",
    "image_size": "1920x1080",
    "image_quality": "high",
    # ---- 上下文自动压缩 ----
    # 估算上下文长度（字符数）超过 context_max_chars * 触发比例时，
    # 把靠前的历史交给模型总结成一段摘要，保留最近的原文。
    "context_auto_compact": True,
    "context_max_chars": 120000,
    "context_compact_trigger_percent": 80,
    "context_keep_recent_chars": 30000,
    # ---- 附件大小限制 ----
    "single_file_max_mb": 20,
    "single_file_max_chars": 60000,
    "message_files_max_mb": 30,
    "message_files_max_chars": 150000,
    # ---- 工具调用与联网搜索 ----
    # 搜索单独配一组上游：主对话模型（Claude 等）走 /chat/completions，
    # 而服务端内置的 web_search 只挂在 DeepSeek 的 /responses 上，两者不是同一家。
    # 配置存成列表，官方直连和各家中转站可以各存一条随时切换，
    # search_provider_id 指向当前正在用的那条。
    "tools_enabled": True,
    "search_providers": DEFAULT_SEARCH_PROVIDERS,
    "search_provider_id": "default",
    # ---- 回答风格 ----
    # 全部风格（含内置）存在这一个键里，方便用户改内置风格的措辞。
    # 会话没指定风格时用 default_style_id。
    "styles": BUILTIN_STYLES,
    "default_style_id": "normal",
    # ---- 长期记忆 ----
    # 跨会话保留的用户事实与偏好，每轮拼进系统提示词。条数与单条长度都要限，
    # 否则记忆会无声地吃掉上下文预算。auto_capture 决定是否把 remember 工具
    # 声明给模型；关掉之后仍然可以在设置里手工维护。
    "memory_enabled": True,
    "memory_auto_capture": True,
    "memory_max_items": 50,
    "memory_max_chars": 4000,
    # ---- 提示词模板 ----
    # 只是输入框的便利工具：选中后把正文填进输入框，由用户决定改不改、发不发，
    # 不会自动进系统提示词。正文里的 {{input}} 用输入框已有的文字替换。
    "prompt_templates": DEFAULT_PROMPT_TEMPLATES,
    # ---- 代码执行 ----
    # 默认关闭，且开启后每次执行仍要用户确认。这是全项目风险最高的开关：
    # 子进程以当前用户身份运行，白名单是代码层面的限制而非操作系统沙箱。
    "code_exec_enabled": False,
    # ---- 诊断 ----
    # 开启后记录 DEBUG 级别日志与请求/响应正文摘要，用于排查难以复现的问题。
    # 正文可能包含对话内容，因此默认关闭。
    "verbose_logging": False,
}


def get_settings() -> dict:
    with get_db() as db:
        rows = db.execute("SELECT key, value FROM settings").fetchall()
    stored = {r["key"]: json.loads(r["value"]) for r in rows}
    merged = {**DEFAULT_SETTINGS, **stored}
    # 旧版本的图片功能与聊天共用 API 配置。首次读取时复制到新字段并持久化，
    # 确保此后单独修改聊天配置不会连带改变图片配置。
    migrated = {}
    if "image_base_url" not in stored and "base_url" in stored:
        migrated["image_base_url"] = stored["base_url"]
    if "image_api_key" not in stored and "api_key" in stored:
        migrated["image_api_key"] = stored["api_key"]
    # 旧版本的搜索配置是四个平铺字段，只能配一套。转成列表里的第一条，
    # 老用户升级后配置不丢，也不用重填。
    if "search_providers" not in stored and any(
        key in stored for key in _LEGACY_SEARCH_KEYS
    ):
        migrated["search_providers"] = [{
            "id": "default",
            "name": "默认配置",
            "base_url": stored.get("search_base_url") or "https://api.deepseek.com",
            "api_key": stored.get("search_api_key") or "",
            "model": stored.get("search_model") or "deepseek-v4-flash",
            "max_output_tokens": stored.get("search_max_output_tokens") or 4000,
        }]
        migrated["search_provider_id"] = "default"
    if migrated:
        with get_db() as db:
            for key, value in migrated.items():
                db.execute(
                    "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
                    (key, json.dumps(value, ensure_ascii=False)),
                )
        merged.update(migrated)
    # browser_search_enabled 是早期版本留下的死设置，没有任何代码读它。
    # 留着会让人误以为联网开关在这里，顺手清掉。
    if "browser_search_enabled" in stored:
        with get_db() as db:
            db.execute("DELETE FROM settings WHERE key='browser_search_enabled'")
        merged.pop("browser_search_enabled", None)
    # 迁移完就把旧的平铺搜索字段清掉：前端保存时会把整个设置对象发回来，
    # 而接口模型不接受未知字段，留着反而会让保存失败。
    stale = [key for key in _LEGACY_SEARCH_KEYS if key in stored]
    if stale:
        with get_db() as db:
            for key in stale:
                db.execute("DELETE FROM settings WHERE key=?", (key,))
    for key in _LEGACY_SEARCH_KEYS:
        merged.pop(key, None)
    merged["search_providers"] = _normalize_search_providers(merged.get("search_providers"))
    ids = {p["id"] for p in merged["search_providers"]}
    if merged.get("search_provider_id") not in ids:
        merged["search_provider_id"] = merged["search_providers"][0]["id"]
    merged["styles"] = _normalize_styles(merged.get("styles"))
    merged["image_providers"] = _normalize_image_providers(merged.get("image_providers"))
    # 旧版本的图片功能只能配一套，散在 image_base_url / image_api_key / image_model
    # 三个字段里。列表为空且旧字段填过内容时，转成列表里的第一条。
    if not merged["image_providers"] and (
        merged.get("image_api_key") or merged.get("image_base_url")
    ):
        merged["image_providers"] = [{
            "id": "default",
            "name": "默认渠道",
            "base_url": merged.get("image_base_url") or "",
            "api_key": merged.get("image_api_key") or "",
            "model": merged.get("image_model") or "",
            "enabled": True,
        }]
    # 三个旧字段继续保留，作为「当前生效渠道」的镜像：图片页顶部显示的模型名
    # 和后端的若干校验都还读它们，同步一份可以不用改那些地方。
    _mirror_active_image_provider(merged)
    merged["prompt_templates"] = _normalize_prompt_templates(merged.get("prompt_templates"))
    return merged


def active_image_providers(settings: dict) -> list[dict]:
    """按列表顺序返回可用的图片渠道（启用且填了密钥）。"""
    return [
        provider for provider in settings.get("image_providers") or []
        if provider.get("enabled") is not False and (provider.get("api_key") or "").strip()
    ]


def _mirror_active_image_provider(settings: dict) -> None:
    """把第一个可用渠道抄进 image_base_url / image_api_key / image_model。

    列表非空但一个可用的都没有（全禁用或都没填密钥）时要把镜像清空，
    否则删掉最后一个渠道之后，旧字段里残留的密钥还会继续把图画出来。
    列表整个为空则不动——那是从没配过图片渠道的全新安装。
    """
    if not settings.get("image_providers"):
        return
    usable = active_image_providers(settings)
    if not usable:
        settings["image_base_url"] = ""
        settings["image_api_key"] = ""
        return
    first = usable[0]
    settings["image_base_url"] = first.get("base_url") or ""
    settings["image_api_key"] = first.get("api_key") or ""
    if first.get("model"):
        settings["image_model"] = first["model"]


# 旧版本的单套搜索配置字段，只在迁移时读一次，之后从库里删掉。
_LEGACY_SEARCH_KEYS = (
    "search_base_url", "search_api_key", "search_model", "search_max_output_tokens",
)


def _normalize_search_providers(stored) -> list[dict]:
    """把搜索配置列表补成固定形状，并保证至少有一条、id 不重复。

    前端删光了也要留一条：为空时联网设置页会没有任何可编辑的东西，
    用户只能重置设置才能恢复。
    """
    if not isinstance(stored, list):
        stored = []
    result: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(stored):
        if not isinstance(item, dict):
            continue
        pid = str(item.get("id") or "") or f"search-{index}"
        while pid in seen:
            pid = f"{pid}-{index}"
        seen.add(pid)
        try:
            budget = int(item.get("max_output_tokens") or 4000)
        except (TypeError, ValueError):
            budget = 4000
        result.append({
            "id": pid,
            "name": str(item.get("name") or "未命名配置"),
            "base_url": str(item.get("base_url") or ""),
            "api_key": str(item.get("api_key") or ""),
            "model": str(item.get("model") or ""),
            "max_output_tokens": max(budget, 512),
        })
    return result or [dict(p) for p in DEFAULT_SEARCH_PROVIDERS]


def _normalize_image_providers(stored) -> list[dict]:
    """把图片渠道列表补成固定形状，id 不重复。

    和搜索配置不同，这里允许为空：一条图片渠道都没有时图片功能本来就没配好，
    界面会提示去添加，没必要凭空造一条假的出来。顺序有意义——生成图片时
    按列表从上往下找第一个能用的渠道，和桌面端「多 API」的故障转移一致。
    """
    if not isinstance(stored, list):
        return []
    result: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(stored):
        if not isinstance(item, dict):
            continue
        pid = str(item.get("id") or "") or f"image-{index}"
        while pid in seen:
            pid = f"{pid}-{index}"
        seen.add(pid)
        result.append({
            "id": pid,
            "name": str(item.get("name") or f"图片渠道 {index + 1}"),
            "base_url": str(item.get("base_url") or ""),
            "api_key": str(item.get("api_key") or ""),
            "model": str(item.get("model") or ""),
            "enabled": item.get("enabled") is not False,
        })
    return result


def _normalize_prompt_templates(stored) -> list[dict]:
    """丢掉形状不对的模板。与风格不同，模板全都可删，所以不补内置项。"""
    if not isinstance(stored, list):
        return []
    result = []
    for item in stored:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        result.append({
            "id": str(item["id"]),
            "name": str(item.get("name") or item["id"]),
            "content": str(item.get("content") or ""),
        })
    return result


def _normalize_styles(stored_styles) -> list[dict]:
    """保证内置风格始终存在且带 builtin 标记，同时丢掉形状不对的自定义项。

    用户存过的内置风格（可能改了措辞）优先于默认值，新版本追加的内置风格
    会自动补进来，这样升级后不需要重置设置。
    """
    if not isinstance(stored_styles, list):
        stored_styles = []
    by_id: dict[str, dict] = {}
    for item in stored_styles:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        by_id[str(item["id"])] = {
            "id": str(item["id"]),
            "name": str(item.get("name") or item["id"]),
            "prompt": str(item.get("prompt") or ""),
        }
    result = []
    for builtin in BUILTIN_STYLES:
        saved = by_id.pop(builtin["id"], None)
        merged_style = {**builtin, **(saved or {}), "builtin": True}
        if builtin["id"] == "normal":
            # 「正常」就是不加风格指令，允许改名但不允许塞内容。
            merged_style["prompt"] = ""
        result.append(merged_style)
    for custom in by_id.values():
        result.append({**custom, "builtin": False})
    return result


def style_prompt(settings: dict, style_id: str | None) -> str:
    """取某个风格的追加指令。id 缺失或已被删除时回落到默认风格。"""
    styles = {s["id"]: s for s in _normalize_styles(settings.get("styles"))}
    style = styles.get(style_id or "") or styles.get(settings.get("default_style_id") or "")
    return (style or {}).get("prompt") or ""


def save_settings(patch: dict) -> dict:
    with get_db() as db:
        for k, v in patch.items():
            db.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (k, json.dumps(v, ensure_ascii=False)),
            )
    return get_settings()


# ---------- 会话 ----------

def list_conversations() -> list[dict]:
    with get_db() as db:
        rows = db.execute(
            "SELECT id, title, created_at, updated_at, pinned, project_id, style_id "
            "FROM conversations ORDER BY pinned DESC, updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def create_conversation(
    title: str = "新对话",
    project_id: str | None = None,
    style_id: str | None = None,
    memory_enabled: bool = False,
    memory_ids: list[str] | None = None,
) -> dict:
    cid = str(uuid.uuid4())
    ts = now_iso()
    ids = list(memory_ids or [])
    with get_db() as db:
        db.execute(
            "INSERT INTO conversations"
            "(id, title, created_at, updated_at, project_id, style_id,"
            " memory_enabled, memory_ids) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (cid, title, ts, ts, project_id, style_id,
             1 if memory_enabled else 0, json.dumps(ids)),
        )
    return {
        "id": cid, "title": title, "created_at": ts, "updated_at": ts, "pinned": 0,
        "project_id": project_id, "style_id": style_id,
        "memory_enabled": bool(memory_enabled), "memory_ids": ids,
    }


def _like_pattern(q: str) -> str:
    """把用户输入转成 LIKE 模式串，转义掉 % _ \\ 这三个通配/转义字符。"""
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def search_messages(query: str, limit: int = 60) -> list[dict]:
    """按正文搜索消息，按会话聚合。

    每个会话只回最近一条命中，附带该会话的命中总数，够侧边栏展示了；
    要看全部命中可以进会话再用浏览器搜索。
    """
    q = (query or "").strip()
    if not q:
        return []
    pattern = _like_pattern(q)
    with get_db() as db:
        rows = db.execute(
            """
            SELECT m.conversation_id, c.title, c.project_id, c.updated_at,
                   m.id AS message_id, m.role, m.content, m.created_at,
                   (SELECT COUNT(*) FROM messages m2
                     WHERE m2.conversation_id = m.conversation_id
                       AND m2.content LIKE ? ESCAPE '\\') AS match_count
              FROM messages m
              JOIN conversations c ON c.id = m.conversation_id
             WHERE m.content LIKE ? ESCAPE '\\'
               AND m.id = (SELECT m3.id FROM messages m3
                            WHERE m3.conversation_id = m.conversation_id
                              AND m3.content LIKE ? ESCAPE '\\'
                            ORDER BY m3.created_at DESC, m3.rowid DESC LIMIT 1)
             ORDER BY c.pinned DESC, c.updated_at DESC
             LIMIT ?
            """,
            (pattern, pattern, pattern, max(1, limit)),
        ).fetchall()
    return [dict(r) for r in rows]


def set_conversation_project(cid: str, project_id: str | None):
    with get_db() as db:
        db.execute(
            "UPDATE conversations SET project_id=?, updated_at=? WHERE id=?",
            (project_id, now_iso(), cid),
        )


def set_conversation_style(cid: str, style_id: str | None):
    with get_db() as db:
        db.execute("UPDATE conversations SET style_id=? WHERE id=?", (style_id, cid))


def set_conversation_memory(cid: str, enabled: bool, memory_ids: list[str]):
    """记下这个会话要不要带记忆、带哪几条。

    不动 updated_at：开关记忆不是「对话有了新内容」，让它影响侧边栏的排序
    会很突兀（set_conversation_style 出于同样的理由也不动）。
    """
    with get_db() as db:
        db.execute(
            "UPDATE conversations SET memory_enabled=?, memory_ids=? WHERE id=?",
            (1 if enabled else 0, json.dumps(list(memory_ids or [])), cid),
        )


def rename_conversation(cid: str, title: str):
    with get_db() as db:
        db.execute(
            "UPDATE conversations SET title=?, updated_at=? WHERE id=?",
            (title, now_iso(), cid),
        )


def delete_conversation(cid: str):
    with get_db() as db:
        db.execute("DELETE FROM conversations WHERE id=?", (cid,))


def touch_conversation(db, cid: str):
    db.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now_iso(), cid))


# ---------- 项目 ----------

def list_projects() -> list[dict]:
    """按更新时间返回项目，并带上各自的会话数量。"""
    with get_db() as db:
        rows = db.execute(
            "SELECT p.*, ("
            "  SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id"
            ") AS conversation_count "
            "FROM projects p ORDER BY p.updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_project(pid: str) -> dict | None:
    with get_db() as db:
        row = db.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    return dict(row) if row else None


def create_project(name: str, description: str = "", instructions: str = "") -> dict:
    pid = str(uuid.uuid4())
    ts = now_iso()
    with get_db() as db:
        db.execute(
            "INSERT INTO projects(id, name, description, instructions, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?)",
            (pid, name, description, instructions, ts, ts),
        )
    return {
        "id": pid, "name": name, "description": description,
        "instructions": instructions, "created_at": ts, "updated_at": ts,
        "conversation_count": 0,
    }


def update_project(
    pid: str,
    name: str | None = None,
    description: str | None = None,
    instructions: str | None = None,
) -> dict | None:
    fields = {"name": name, "description": description, "instructions": instructions}
    sets = {k: v for k, v in fields.items() if v is not None}
    if sets:
        assignments = ", ".join(f"{k}=?" for k in sets)
        with get_db() as db:
            db.execute(
                f"UPDATE projects SET {assignments}, updated_at=? WHERE id=?",
                (*sets.values(), now_iso(), pid),
            )
    return get_project(pid)


def delete_project(pid: str, delete_conversations: bool = False):
    """删除项目。默认只解除会话归属，会话本身保留。"""
    with get_db() as db:
        if delete_conversations:
            db.execute("DELETE FROM conversations WHERE project_id=?", (pid,))
        else:
            db.execute("UPDATE conversations SET project_id=NULL WHERE project_id=?", (pid,))
        db.execute("DELETE FROM projects WHERE id=?", (pid,))


# ---------- 长期记忆 ----------

def list_memories() -> list[dict]:
    """新的在前：条数超限时淘汰的是最旧的一条。

    created_at 只到秒，同一秒写入多条时排序会不稳定，因此用 rowid 兜底
    ——它严格按写入顺序递增，正好是我们想要的次序。
    """
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM memories ORDER BY created_at DESC, rowid DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_memory(mid: str) -> dict | None:
    with get_db() as db:
        row = db.execute("SELECT * FROM memories WHERE id=?", (mid,)).fetchone()
    return dict(row) if row else None


def find_memory_by_content(content: str) -> dict | None:
    """按正文查重。模型常常在多轮里重复记同一件事，重复写入没有意义。"""
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM memories WHERE content=? LIMIT 1", (content.strip(),)
        ).fetchone()
    return dict(row) if row else None


def add_memory(content: str, source_conversation_id: str | None = None) -> dict:
    mid = str(uuid.uuid4())
    ts = now_iso()
    with get_db() as db:
        db.execute(
            "INSERT INTO memories(id, content, source_conversation_id, created_at, updated_at) "
            "VALUES(?,?,?,?,?)",
            (mid, content, source_conversation_id, ts, ts),
        )
    return {
        "id": mid, "content": content,
        "source_conversation_id": source_conversation_id,
        "created_at": ts, "updated_at": ts,
    }


def update_memory(mid: str, content: str) -> dict | None:
    with get_db() as db:
        db.execute(
            "UPDATE memories SET content=?, updated_at=? WHERE id=?",
            (content, now_iso(), mid),
        )
    return get_memory(mid)


def delete_memory(mid: str):
    with get_db() as db:
        db.execute("DELETE FROM memories WHERE id=?", (mid,))


def clear_memories():
    with get_db() as db:
        db.execute("DELETE FROM memories")


def trim_memories(max_items: int) -> int:
    """把总条数压到上限以内，删掉最旧的若干条，返回删除数量。"""
    if max_items <= 0:
        return 0
    with get_db() as db:
        rows = db.execute(
            "SELECT id FROM memories ORDER BY created_at DESC, rowid DESC "
            "LIMIT -1 OFFSET ?",
            (max_items,),
        ).fetchall()
        for row in rows:
            db.execute("DELETE FROM memories WHERE id=?", (row["id"],))
    return len(rows)


# ---------- 消息树 ----------

def add_message(
    cid: str,
    role: str,
    content: str,
    parent_id: str | None,
    thinking: str | None = None,
    model: str | None = None,
    attachments: list | None = None,
    set_active: bool = True,
) -> dict:
    mid = str(uuid.uuid4())
    ts = now_iso()
    with get_db() as db:
        db.execute(
            "INSERT INTO messages(id, conversation_id, parent_id, role, content, thinking, model, attachments, created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (
                mid, cid, parent_id, role, content, thinking, model,
                json.dumps(attachments, ensure_ascii=False) if attachments else None,
                ts,
            ),
        )
        if set_active:
            db.execute("UPDATE conversations SET active_leaf_id=? WHERE id=?", (mid, cid))
        touch_conversation(db, cid)
    return {
        "id": mid, "conversation_id": cid, "parent_id": parent_id, "role": role,
        "content": content, "thinking": thinking, "model": model,
        "attachments": attachments or [], "created_at": ts,
    }


def update_message(
    mid: str,
    content: str | None = None,
    thinking: str | None = None,
    tool_calls: list | None = None,
):
    with get_db() as db:
        if content is not None:
            db.execute("UPDATE messages SET content=? WHERE id=?", (content, mid))
        if thinking is not None:
            db.execute("UPDATE messages SET thinking=? WHERE id=?", (thinking, mid))
        if tool_calls is not None:
            db.execute(
                "UPDATE messages SET tool_calls=? WHERE id=?",
                (json.dumps(tool_calls, ensure_ascii=False) if tool_calls else None, mid),
            )


def _json_list(raw) -> list:
    """把存成 JSON 文本的列表读回来。列缺失、为空或内容坏掉时一律当空列表。"""
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def _row_to_msg(r) -> dict:
    return {
        "id": r["id"],
        "parent_id": r["parent_id"],
        "role": r["role"],
        "content": r["content"],
        "thinking": r["thinking"],
        "model": r["model"],
        "attachments": json.loads(r["attachments"]) if r["attachments"] else [],
        # 迁移前写入的旧消息没有这一列，用 keys() 判断而不是直接取值。
        "tool_calls": (
            json.loads(r["tool_calls"])
            if "tool_calls" in r.keys() and r["tool_calls"]
            else []
        ),
        "created_at": r["created_at"],
    }


def get_conversation_tree(cid: str) -> dict:
    """返回会话信息 + 全部消息（树）+ 当前激活路径"""
    with get_db() as db:
        conv = db.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
        if not conv:
            return None
        rows = db.execute(
            "SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at, id",
            (cid,),
        ).fetchall()
    messages = [_row_to_msg(r) for r in rows]
    return {
        "id": conv["id"],
        "title": conv["title"],
        "created_at": conv["created_at"],
        "updated_at": conv["updated_at"],
        "active_leaf_id": conv["active_leaf_id"],
        # 迁移前建的会话没有这几列，取值前先确认列存在。
        "project_id": conv["project_id"] if "project_id" in conv.keys() else None,
        "style_id": conv["style_id"] if "style_id" in conv.keys() else None,
        "memory_enabled": bool(
            conv["memory_enabled"] if "memory_enabled" in conv.keys() else 0
        ),
        "memory_ids": _json_list(
            conv["memory_ids"] if "memory_ids" in conv.keys() else None
        ),
        "messages": messages,
    }


def get_active_path(cid: str) -> list[dict]:
    """从 active_leaf 回溯到根，返回按时间顺序排列的消息链"""
    tree = get_conversation_tree(cid)
    if not tree:
        return []
    by_id = {m["id"]: m for m in tree["messages"]}
    path = []
    cur = by_id.get(tree["active_leaf_id"])
    while cur:
        path.append(cur)
        cur = by_id.get(cur["parent_id"]) if cur["parent_id"] else None
    path.reverse()
    return path


def set_active_leaf(cid: str, leaf_id: str):
    with get_db() as db:
        db.execute("UPDATE conversations SET active_leaf_id=? WHERE id=?", (leaf_id, cid))


def find_latest_leaf(cid: str, node_id: str) -> str:
    """找到以 node_id 为根的子树中最新的叶子节点"""
    tree = get_conversation_tree(cid)
    children_map: dict[str | None, list[dict]] = {}
    for m in tree["messages"]:
        children_map.setdefault(m["parent_id"], []).append(m)
    cur_id = node_id
    while True:
        kids = children_map.get(cur_id, [])
        if not kids:
            return cur_id
        # 走最新的孩子
        cur_id = kids[-1]["id"]


# ---------- 图片生成记录 ----------

def _row_json_list(r, key: str) -> list:
    """安全读取 JSON 数组列：老库可能还没有该列。"""
    if key not in r.keys():
        return []
    try:
        value = json.loads(r[key] or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    return value if isinstance(value, list) else []


def _row_to_image(r) -> dict:
    return {
        "id": r["id"],
        "mode": r["mode"],
        "prompt": r["prompt"],
        "negative_prompt": r["negative_prompt"],
        "model": r["model"],
        "size": r["size"],
        "quality": r["quality"],
        "source_image_name": r["source_image_name"],
        "reference_names": _row_json_list(r, "reference_names"),
        "reference_notes": _row_json_list(r, "reference_notes"),
        "files": json.loads(r["files"]),
        "created_at": r["created_at"],
    }


def list_images() -> list[dict]:
    with get_db() as db:
        rows = db.execute("SELECT * FROM images ORDER BY created_at DESC, id").fetchall()
    return [_row_to_image(r) for r in rows]


def add_image_record(
    mode: str,
    prompt: str,
    negative_prompt: str,
    model: str,
    size: str,
    quality: str,
    files: list[str],
    source_image_name: str = "",
    created_at: str | None = None,
    record_id: str | None = None,
    reference_names: list[str] | None = None,
    reference_notes: list[str] | None = None,
) -> dict:
    rid = record_id or str(uuid.uuid4())
    ts = created_at or now_iso()
    ref_names = list(reference_names or [])
    ref_notes = list(reference_notes or [])
    with get_db() as db:
        db.execute(
            "INSERT INTO images(id, mode, prompt, negative_prompt, model, size, quality, "
            "source_image_name, reference_names, reference_notes, files, created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, mode, prompt, negative_prompt, model, size, quality,
             source_image_name,
             json.dumps(ref_names, ensure_ascii=False),
             json.dumps(ref_notes, ensure_ascii=False),
             json.dumps(files, ensure_ascii=False), ts),
        )
    return {
        "id": rid, "mode": mode, "prompt": prompt, "negative_prompt": negative_prompt,
        "model": model, "size": size, "quality": quality,
        "source_image_name": source_image_name,
        "reference_names": ref_names, "reference_notes": ref_notes,
        "files": files, "created_at": ts,
    }


def delete_image_record(rid: str) -> list[str]:
    """删除记录并返回其文件名列表（供调用方清理磁盘文件）"""
    with get_db() as db:
        row = db.execute("SELECT files FROM images WHERE id=?", (rid,)).fetchone()
        db.execute("DELETE FROM images WHERE id=?", (rid,))
    return json.loads(row["files"]) if row else []


def image_record_exists(rid: str) -> bool:
    with get_db() as db:
        row = db.execute("SELECT 1 FROM images WHERE id=?", (rid,)).fetchone()
    return row is not None


# ---------- 上下文压缩摘要 ----------

def _row_to_summary(r) -> dict:
    return {
        "id": r["id"],
        "conversation_id": r["conversation_id"],
        "covered_until_message_id": r["covered_until_message_id"],
        "summary": r["summary"],
        "original_chars": r["original_chars"],
        "summary_chars": r["summary_chars"],
        "created_at": r["created_at"],
    }


def list_context_summaries(cid: str) -> list[dict]:
    """按生成时间返回某个会话的全部压缩摘要。"""
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM context_summaries WHERE conversation_id=? "
            "ORDER BY created_at, id",
            (cid,),
        ).fetchall()
    return [_row_to_summary(r) for r in rows]


def add_context_summary(
    cid: str,
    covered_until_message_id: str,
    summary: str,
    original_chars: int,
    summary_chars: int,
) -> dict:
    sid = str(uuid.uuid4())
    ts = now_iso()
    with get_db() as db:
        db.execute(
            "INSERT INTO context_summaries(id, conversation_id, covered_until_message_id, "
            "summary, original_chars, summary_chars, created_at) VALUES(?,?,?,?,?,?,?)",
            (sid, cid, covered_until_message_id, summary,
             int(original_chars), int(summary_chars), ts),
        )
    return {
        "id": sid,
        "conversation_id": cid,
        "covered_until_message_id": covered_until_message_id,
        "summary": summary,
        "original_chars": int(original_chars),
        "summary_chars": int(summary_chars),
        "created_at": ts,
    }


def clear_context_summaries(cid: str) -> None:
    with get_db() as db:
        db.execute("DELETE FROM context_summaries WHERE conversation_id=?", (cid,))
