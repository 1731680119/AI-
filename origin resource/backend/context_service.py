"""上下文自动压缩。

长对话会让每次请求携带的历史越来越长，最终超出模型窗口或大量浪费费用。
这里的做法是：当估算出的上下文长度超过设定阈值时，把靠前的历史交给模型
总结成一段摘要存进 context_summaries 表，之后的请求只发送
「历史摘要 + 最近若干原文」。摘要一旦生成就会复用，不会重复调用模型。
"""
from __future__ import annotations

import database as db
import llm


# 一张图片按固定字符数计入预算：图片实际是 base64，用真实长度会严重高估。
IMAGE_COST_CHARS = 1600

SUMMARY_SYSTEM_PROMPT = (
    "你是对话历史压缩助手。请把给定的对话历史压缩成简洁的中文摘要，"
    "务必保留：用户的目标与偏好、已确认的事实与数据、已做出的决定、"
    "尚未解决的问题、以及后续对话需要的关键上下文。"
    "不要编造内容，不要输出寒暄或解释，直接给出摘要正文。"
)

SUMMARY_BLOCK_TEMPLATE = (
    "以下是本次对话较早部分的历史摘要（原文已因长度限制省略），"
    "请把它当作已经发生过的对话内容：\n{summary}"
)


def _int_setting(settings: dict, key: str, default: int) -> int:
    try:
        return int(settings.get(key, default))
    except (TypeError, ValueError):
        return default


def message_chars(message: dict) -> int:
    """估算一条消息占用的上下文长度（字符）。"""
    total = len(message.get("content") or "")
    total += len(message.get("thinking") or "") // 4  # thinking 不回传，只做轻微计入
    for attachment in message.get("attachments") or []:
        if attachment.get("kind") == "image":
            total += IMAGE_COST_CHARS
        else:
            total += len(attachment.get("text_content") or "")
    return total


def path_chars(path: list[dict]) -> int:
    return sum(message_chars(m) for m in path)


def system_chars(settings: dict, system_extras: list[str] | None = None) -> int:
    """估算系统提示词占用的上下文长度。

    全局提示词、项目指令、回答风格每轮都会完整重发，属于固定开销。
    不计入的话，长项目指令会悄悄挤占历史预算，压缩阈值算出来偏乐观。
    拼接方式要和 llm.build_api_messages 保持一致。
    """
    blocks = [(settings.get("system_prompt") or "").strip()]
    blocks += [(text or "").strip() for text in (system_extras or [])]
    return len("\n\n".join(b for b in blocks if b))


def _covered_index(path: list[dict], summaries: list[dict]) -> int:
    """返回已被摘要覆盖的消息数量（即 path 中前多少条可以丢弃）。"""
    if not summaries:
        return 0
    covered_id = summaries[-1]["covered_until_message_id"]
    for index, message in enumerate(path):
        if message["id"] == covered_id:
            return index + 1
    return 0


def _render_history(path: list[dict]) -> str:
    """把待压缩的消息渲染成纯文本，供模型阅读。"""
    lines = []
    for message in path:
        role = "用户" if message["role"] == "user" else "助手"
        text = (message.get("content") or "").strip()
        docs = [
            a for a in (message.get("attachments") or [])
            if a.get("kind") != "image" and a.get("text_content")
        ]
        if docs:
            names = "、".join(d.get("name") or "未命名" for d in docs)
            text = f"（附件：{names}）\n{text}" if text else f"（附件：{names}）"
        images = [a for a in (message.get("attachments") or []) if a.get("kind") == "image"]
        if images:
            text = f"（含 {len(images)} 张图片）\n{text}" if text else f"（含 {len(images)} 张图片）"
        lines.append(f"{role}：{text or '（空）'}")
    return "\n\n".join(lines)


def _split_point(path: list[dict], keep_recent_chars: int) -> int:
    """从后往前累计字符，返回应当保留的最早消息下标。"""
    total = 0
    index = len(path)
    while index > 0:
        total += message_chars(path[index - 1])
        if total > keep_recent_chars:
            break
        index -= 1
    # 至少保留最后两条（一问一答），也至少压缩两条，否则压缩没有意义。
    index = min(index, max(len(path) - 2, 0))
    return index


def _combined_summary(summaries: list[dict], extra: str | None = None) -> str:
    parts = [s["summary"] for s in summaries if (s.get("summary") or "").strip()]
    if extra and extra.strip():
        parts.append(extra.strip())
    return "\n\n".join(parts)


def build_context(
    conversation_id: str,
    path: list[dict],
    settings: dict,
    model: str,
    system_extras: list[str] | None = None,
) -> tuple[list[dict], dict]:
    """返回 (api_messages, 压缩信息)。

    压缩信息用于前端提示，形如::

        {"compacted": True, "summary_count": 2, "dropped_messages": 12,
         "before_chars": 130000, "after_chars": 42000}
    """
    overhead = system_chars(settings, system_extras)
    info = {
        "compacted": False,
        "summary_count": 0,
        "dropped_messages": 0,
        "before_chars": overhead + path_chars(path),
        "after_chars": overhead + path_chars(path),
        "error": None,
    }

    if not settings.get("context_auto_compact", True):
        return llm.build_api_messages(path, settings, system_extras), info

    max_chars = max(_int_setting(settings, "context_max_chars", 120000), 4000)
    trigger_percent = min(max(_int_setting(settings, "context_compact_trigger_percent", 80), 10), 100)
    keep_recent_chars = max(_int_setting(settings, "context_keep_recent_chars", 30000), 2000)
    threshold = max_chars * trigger_percent // 100

    summaries = db.list_context_summaries(conversation_id)
    covered = _covered_index(path, summaries)
    if covered == 0 and summaries:
        # 摘要覆盖点不在当前分支上（例如用户切换到了别的分支），本轮忽略旧摘要。
        summaries = []
    remaining = path[covered:]
    info["summary_count"] = len(summaries)
    info["dropped_messages"] = covered
    info["compacted"] = covered > 0

    new_summary_text = None
    if overhead + path_chars(remaining) > threshold and len(remaining) > 2:
        split = _split_point(remaining, keep_recent_chars)
        to_compact = remaining[:split]
        if to_compact:
            history_text = _render_history(to_compact)
            previous = _combined_summary(summaries)
            user_prompt = history_text
            if previous:
                user_prompt = (
                    f"这是更早历史的已有摘要：\n{previous}\n\n"
                    f"这是需要新增压缩的对话历史：\n{history_text}\n\n"
                    "请输出一段整合后的摘要，覆盖上面的全部内容。"
                )
            try:
                new_summary_text = llm.complete_text(
                    settings,
                    model,
                    [
                        {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt},
                    ],
                    max_tokens=1600,
                    temperature=0.2,
                )
            except Exception as exc:  # 压缩失败不能阻塞对话
                info["error"] = str(exc)
                new_summary_text = None

            if new_summary_text:
                record = db.add_context_summary(
                    conversation_id,
                    to_compact[-1]["id"],
                    new_summary_text,
                    path_chars(to_compact),
                    len(new_summary_text),
                )
                if previous:
                    # 新摘要已整合旧摘要，旧记录不再参与拼接。
                    summaries = [record]
                else:
                    summaries = summaries + [record]
                remaining = remaining[split:]
                info["compacted"] = True
                info["dropped_messages"] = covered + split
                info["summary_count"] = len(summaries)

    summary_text = _combined_summary(summaries)
    api_messages = llm.build_api_messages(remaining, settings, system_extras)
    if summary_text:
        block = SUMMARY_BLOCK_TEMPLATE.format(summary=summary_text)
        insert_at = 1 if api_messages and api_messages[0]["role"] == "system" else 0
        api_messages.insert(insert_at, {"role": "system", "content": block})
        info["after_chars"] = overhead + path_chars(remaining) + len(block)
    else:
        info["after_chars"] = overhead + path_chars(remaining)

    return api_messages, info
