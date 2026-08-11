"""长期记忆：跨会话保留的用户事实与偏好。

和上下文压缩的分工值得写清楚，两者都在省上下文，但省的东西不同：
  * 压缩摘要属于单个会话，随会话消亡，目的是让长对话还能继续。
  * 长期记忆是全局的，只存值得跨会话复用的结论（称呼、技术栈、长期偏好），
    每轮完整拼进系统提示词。

写入有两条路：用户在设置里手工增删，或者模型调用 remember 工具。后者是
客户端执行的普通 function，跟 web_search 走同一套流程，因此工具卡片、
错误回填这些都不用另写。

两个上限（条数、总字符）都必须存在：记忆是每轮重发的固定开销，
不设限的话它会在用户完全没察觉的情况下吃掉历史预算。
"""
from typing import Generator

import database as db
import logging_config as diag


TOOL_NAME = "remember"

MEMORY_BLOCK_TEMPLATE = (
    "以下是你在过去对话中记住的、关于这位用户的长期信息，"
    "作答时自然地加以利用，不要主动罗列或提起「我记得」：\n{items}"
)

# 单条记忆的硬上限。记忆应当是一句结论，长篇内容属于项目指令。
ITEM_MAX_CHARS = 500

TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": (
            "把关于用户的长期信息记下来，之后的所有对话都会带上它。"
            "适合记：称呼与身份、长期偏好、常用技术栈与环境、反复交代过的要求。"
            "不要记：一次性的任务内容、可以从当前对话直接读到的信息、"
            "敏感信息（密钥、密码、身份证件号）。"
            "同一件事不要重复记，用户明确说「记住」时应当调用。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "要记住的一句话，写成独立可读的陈述，不要依赖当前对话的上下文。",
                },
            },
            "required": ["content"],
        },
    },
}


def is_configured(settings: dict) -> bool:
    """记忆关闭或不允许自动写入时，不把工具声明给模型。"""
    return bool(settings.get("memory_enabled", True)) and bool(
        settings.get("memory_auto_capture", True)
    )


def _int_setting(settings: dict, key: str, default: int) -> int:
    try:
        return int(settings.get(key, default))
    except (TypeError, ValueError):
        return default


def build_block(settings: dict) -> str:
    """渲染拼进系统提示词的记忆块；没有记忆或功能关闭时返回空串。"""
    if not settings.get("memory_enabled", True):
        return ""
    max_chars = max(_int_setting(settings, "memory_max_chars", 4000), 200)

    lines: list[str] = []
    # 上限说的是整个记忆块，模板本身也占字符，先把它扣掉，
    # 否则实际发出去的长度会超过用户设的数。
    used = len(MEMORY_BLOCK_TEMPLATE.format(items=""))
    for item in reversed(db.list_memories()):  # 旧的在前，读起来更像时间线
        content = (item.get("content") or "").strip()
        if not content:
            continue
        line = f"- {content}"
        if used + len(line) > max_chars:
            # 超预算就停在这里。截断的是最新的记忆，但总字符可控更重要，
            # 而且条数上限本来就在替用户控制总量。
            diag.log_event(
                "DEBUG", "backend", "记忆块达到字符上限，已截断",
                logger="backend.memory", limit=max_chars,
            )
            break
        lines.append(line)
        used += len(line) + 1
    if not lines:
        return ""
    return MEMORY_BLOCK_TEMPLATE.format(items="\n".join(lines))


def remember(settings: dict, content: str, conversation_id: str | None = None) -> dict:
    """写入一条记忆。返回 {"memory": 记录, "duplicate": 是否命中已有记忆}。"""
    text = (content or "").strip()
    if not text:
        raise ValueError("记忆内容为空")
    if len(text) > ITEM_MAX_CHARS:
        text = text[:ITEM_MAX_CHARS]

    existing = db.find_memory_by_content(text)
    if existing:
        return {"memory": existing, "duplicate": True, "trimmed": 0}

    record = db.add_memory(text, conversation_id)
    trimmed = db.trim_memories(max(_int_setting(settings, "memory_max_items", 50), 1))
    # 只记条数，不记正文：日志默认不该留对话内容。
    diag.log_event(
        "INFO", "backend", "写入长期记忆",
        logger="backend.memory", chars=len(text), trimmed=trimmed,
    )
    return {"memory": record, "duplicate": False, "trimmed": trimmed}


def run_tool(
    settings: dict, arguments: dict, context: dict | None = None
) -> Generator[dict, None, dict]:
    """remember 工具的执行体，签名与 tools.py 里其他执行器一致。"""
    content = (arguments.get("content") or "").strip()
    if not content:
        raise ValueError("缺少 content 参数")

    yield {"type": "progress", "message": "正在记住…"}
    result = remember(settings, content, (context or {}).get("conversation_id"))
    memory = result["memory"]
    if result["duplicate"]:
        reply = "这条信息此前已经记住，未重复写入。"
    elif result["trimmed"]:
        reply = f"已记住。记忆条数超过上限，已淘汰最旧的 {result['trimmed']} 条。"
    else:
        reply = "已记住，之后的对话都会带上这条信息。"
    return {
        "content": reply,
        "display": {"text": memory["content"], "duplicate": result["duplicate"]},
    }
