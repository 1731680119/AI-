"""LLM 调用：OpenAI 兼容格式，SSE 流式，兼容 reasoning_content 与 <think> 标签"""
import json
import re
from typing import Any
from typing import Generator

from openai import OpenAI

import logging_config as diag
import model_params


log = diag.get_logger("llm")


def build_client(settings: dict) -> OpenAI:
    kwargs = {"api_key": settings.get("api_key") or "EMPTY"}
    if settings.get("base_url"):
        kwargs["base_url"] = settings["base_url"]
    # 记录用的是哪一个上游和哪一把密钥，是排查 401 / 404 的第一现场。
    diag.log_event(
        "DEBUG", "backend", "创建 LLM 客户端",
        logger="backend.llm",
        base_url=settings.get("base_url") or "(默认)",
        api_key=diag.mask_secret(settings.get("api_key")),
    )
    return OpenAI(**kwargs)


def complete_text(
    settings: dict,
    model: str,
    messages: list[dict],
    max_tokens: int = 800,
    temperature: float = 0.1,
) -> str:
    """Small non-streaming call used by backend orchestration."""
    timer = diag.Timer()
    try:
        # 各家上游认的参数名不一样（GPT-5 系列要 max_completion_tokens），
        # 统一交给兼容层：先按规则改，被顶回来再按上游的提示改一次。
        response = model_params.request_with_healing(
            build_client(settings).chat.completions.create,
            settings.get("base_url") or "",
            model,
            {
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
            },
        )
    except Exception as error:
        diag.log_exception(
            "backend.llm", "非流式请求失败", error,
            model=model, message_count=len(messages), elapsed_ms=timer.elapsed_ms(),
        )
        raise
    text = (response.choices[0].message.content or "").strip()
    diag.log_event(
        "DEBUG", "backend", "非流式请求完成", logger="backend.llm",
        model=model, content_chars=len(text), elapsed_ms=timer.elapsed_ms(),
    )
    return text


def complete_json(
    settings: dict,
    model: str,
    messages: list[dict],
    max_tokens: int = 800,
) -> dict[str, Any]:
    """Request JSON without relying on provider-specific response_format support."""
    raw = complete_text(settings, model, messages, max_tokens=max_tokens)
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.S | re.I)
    candidate = fenced.group(1) if fenced else raw
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            return json.loads(raw[start:end + 1])
        # 模型没按要求返回 JSON。记录原文开头，否则这类问题完全无从下手。
        diag.log_event(
            "ERROR", "backend", "模型未返回可解析的 JSON", logger="backend.llm",
            model=model, raw_chars=len(raw), raw_head=raw[:200],
        )
        raise


def _int_setting(settings: dict, key: str, default: int) -> int:
    try:
        return int(settings.get(key, default))
    except (TypeError, ValueError):
        return default


def _clip(text: str, limit: int, note: str) -> str:
    """按字符数截断文档正文，并在末尾说明已截断。"""
    if limit <= 0 or len(text) <= limit:
        return text
    return text[:limit] + f"\n\n[{note}]"


def build_doc_blocks(docs: list[dict], settings: dict) -> str:
    """把文档附件拼成 <document> 块，并应用单文件 / 单条消息的字符上限。"""
    single_max = max(_int_setting(settings, "single_file_max_chars", 60000), 1000)
    total_max = max(_int_setting(settings, "message_files_max_chars", 150000), single_max)

    blocks: list[str] = []
    used = 0
    for index, doc in enumerate(docs):
        name = doc.get("name") or "未命名文件"
        body = doc.get("text_content") or ""
        body = _clip(body, single_max, f"该文件正文超过 {single_max} 字，已截断")

        remaining = total_max - used
        if remaining <= 0:
            skipped = len(docs) - index
            blocks.append(f"[本条消息附件正文已达 {total_max} 字上限，剩余 {skipped} 个文件未发送]")
            break
        if len(body) > remaining:
            body = _clip(body, remaining, f"本条消息附件正文已达 {total_max} 字上限，此处截断")

        blocks.append(f"<document name=\"{name}\">\n{body}\n</document>")
        used += len(body)
    return "\n\n".join(blocks)


def build_api_messages(
    path: list[dict],
    settings: dict,
    system_extras: list[str] | None = None,
    tool_schemas: list[dict] | None = None,
) -> list[dict]:
    """把消息链转换为 OpenAI 兼容的 messages 数组，处理附件。

    system_extras 是项目指令、回答风格这类附加约束，拼在全局系统提示词之后，
    合并成同一条 system 消息 —— 有些上游只认第一条 system。
    tool_schemas 用于判断是否需要在 system 里加工具使用指引。
    """
    api_msgs = []
    blocks = [(settings.get("system_prompt") or "").strip()]
    blocks += [(text or "").strip() for text in (system_extras or [])]

    # 如果声明了工具，在 system 里加使用指引（提高模型调用工具的主动性）
    if tool_schemas:
        tool_guidance = (
            "## 工具使用原则\n"
            "你可以使用 web_search 工具联网搜索。以下情况**必须优先调用工具**而不是直接回答：\n"
            "- 问题涉及实时信息、近期事件、具体数据、价格、产品、公司、厂商\n"
            "- 问题要求列举、推荐、对比、排名、查询具体名单\n"
            "- 需要核实事实或你对答案不够确定\n"
            "不要仅凭训练数据中的陈旧信息作答，优先使用搜索获取最新、准确的信息。"
        )
        blocks.append(tool_guidance)

    system_prompt = "\n\n".join(b for b in blocks if b)
    if system_prompt:
        api_msgs.append({"role": "system", "content": system_prompt})

    for m in path:
        if m["role"] == "user":
            attachments = m.get("attachments") or []
            images = [a for a in attachments if a.get("kind") == "image"]
            docs = [a for a in attachments if a.get("kind") != "image" and a.get("text_content")]

            text = m["content"]
            if docs:
                doc_blocks = build_doc_blocks(docs, settings)
                text = f"{doc_blocks}\n\n{text}" if text else doc_blocks

            if images:
                content = [{"type": "text", "text": text}] if text else []
                for img in images:
                    if img.get("preview"):
                        content.append({
                            "type": "image_url",
                            "image_url": {"url": img["preview"]},
                        })
                api_msgs.append({"role": "user", "content": content})
            else:
                api_msgs.append({"role": "user", "content": text})
        elif m["role"] == "assistant":
            api_msgs.append({"role": "assistant", "content": m["content"]})
    return api_msgs


THINK_OPEN = re.compile(r"<think(?:ing)?>", re.I)
THINK_CLOSE = re.compile(r"</think(?:ing)?>", re.I)

# 单轮对话里允许的最大工具执行轮数。模型偶尔会陷入反复调用同一工具的循环，
# 这里做硬性截断，超出后要求它直接作答。
MAX_TOOL_ROUNDS = 5


class _ToolCallAssembler:
    """把流式分片拼装成完整的工具调用。

    不能用 tool_calls[].index 做键。OpenAI 规范里并行调用靠这个字段区分，
    但实测某些中转站把它恒定写成 0，真正的序号放在了外层 choices[].index，
    照规范拼装会把两个调用糊成一个（名字和参数首尾相接）。
    以 id 出现为界更稳：带 id 的分片开启一个新调用，不带的追加到当前调用。
    这个判据对两种约定都成立，换回官方接口也无需改动。
    """

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def feed(self, deltas: list) -> None:
        for delta in deltas or []:
            raw = delta if isinstance(delta, dict) else _as_dict(delta)
            function = raw.get("function") or {}
            if raw.get("id"):
                self.calls.append({
                    "id": raw["id"],
                    "name": function.get("name") or "",
                    "arguments": function.get("arguments") or "",
                })
                continue
            if not self.calls:
                # 首个分片就没有 id，说明上游不给 id。补一个占位的，
                # 保证后续能拼装，回填时也有 tool_call_id 可用。
                self.calls.append({
                    "id": f"call_{len(self.calls)}", "name": "", "arguments": "",
                })
            current = self.calls[-1]
            current["name"] += function.get("name") or ""
            current["arguments"] += function.get("arguments") or ""

    def finish(self) -> list[dict]:
        """解析参数 JSON。解析失败保留原文，交由执行层报错给模型。"""
        for call in self.calls:
            try:
                call["parsed"] = json.loads(call["arguments"] or "{}")
            except json.JSONDecodeError:
                call["parsed"] = None
                diag.log_event(
                    "WARNING", "backend", "工具调用参数不是合法 JSON", logger="backend.llm",
                    tool=call["name"], arguments_head=call["arguments"][:200],
                )
        return self.calls


def _as_dict(value) -> dict:
    """SDK 的 pydantic 对象与裸 dict 都要能取字段。"""
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return {
        "id": getattr(value, "id", None),
        "function": {
            "name": getattr(getattr(value, "function", None), "name", None),
            "arguments": getattr(getattr(value, "function", None), "arguments", None),
        },
    }


THINKING_LEVELS = ("auto", "minimal", "low", "medium", "high")


def reasoning_effort(settings: dict, override: str | None = None) -> str | None:
    """把思考档位翻成 reasoning_effort；auto 或非法值返回 None 表示不发这个参数。"""
    level = (override or settings.get("default_thinking") or "auto").strip().lower()
    if level == "auto" or level not in THINKING_LEVELS:
        return None
    return level


def _stream_once(
    settings: dict,
    model: str,
    api_messages: list[dict],
    tool_schemas: list[dict] | None = None,
    effort: str | None = None,
) -> Generator[dict, None, None]:
    """向上游发一次流式请求。

    产出 thinking / content / error 事件，最后产出
    {"type": "turn_done", "content": ..., "thinking": ..., "tool_calls": [...]}。
    tool_calls 非空表示模型要求执行工具，本轮正文通常为空或只是一句过渡语。
    自动兼容 reasoning_content 字段和 <think> 标签两种思考格式。
    """
    client = build_client(settings)
    timer = diag.Timer()
    # 默认只记录条数与体量这类元数据；开了详细日志才记录正文摘要。
    request_meta = {
        "model": model,
        "message_count": len(api_messages),
        "prompt_chars": sum(len(str(item.get("content") or "")) for item in api_messages),
        "temperature": settings.get("temperature"),
        "max_tokens": settings.get("max_tokens"),
        "reasoning_effort": effort or "(未指定)",
    }
    if tool_schemas:
        request_meta["tool_count"] = len(tool_schemas)
    body_preview = diag.verbose_preview(api_messages)
    if body_preview:
        request_meta["request_preview"] = body_preview
    diag.log_event("INFO", "backend", "开始流式对话", logger="backend.llm", **request_meta)

    request_kwargs = {
        "model": model,
        "messages": api_messages,
        "stream": True,
        "temperature": float(settings.get("temperature", 1.0)),
        "max_tokens": int(settings.get("max_tokens", 8192)),
    }
    if effort:
        request_kwargs["reasoning_effort"] = effort
    if tool_schemas:
        request_kwargs["tools"] = tool_schemas
        request_kwargs["tool_choice"] = "auto"

    try:
        # 参数名各家不统一（GPT-5 系列只认 max_completion_tokens，有的中转站不接受
        # reasoning_effort 和 tools 同时出现），交给兼容层按规则改 + 按 400 提示自愈。
        stream = model_params.request_with_healing(
            client.chat.completions.create,
            settings.get("base_url") or "",
            model,
            request_kwargs,
        )
    except Exception as e:
        diag.log_exception(
            "backend.llm", "发起流式请求失败", e,
            model=model,
            base_url=settings.get("base_url") or "(默认)",
            elapsed_ms=timer.elapsed_ms(),
        )
        yield {"type": "error", "message": str(e)}
        return

    full_content = ""
    full_thinking = ""
    in_think_tag = False   # 正在 <think> 标签内
    pending = ""           # 用于跨 chunk 检测标签的缓冲
    assembler = _ToolCallAssembler()

    try:
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta

            if getattr(delta, "tool_calls", None):
                assembler.feed(delta.tool_calls)

            # 1) reasoning_content 字段（DeepSeek/中转常见）
            reasoning = getattr(delta, "reasoning_content", None) or (
                delta.model_extra.get("reasoning_content") if getattr(delta, "model_extra", None) else None
            )
            if reasoning:
                full_thinking += reasoning
                yield {"type": "thinking", "text": reasoning}

            piece = delta.content or ""
            if not piece:
                continue

            # 2) <think> 标签检测
            pending += piece
            while pending:
                if in_think_tag:
                    m = THINK_CLOSE.search(pending)
                    if m:
                        seg = pending[:m.start()]
                        if seg:
                            full_thinking += seg
                            yield {"type": "thinking", "text": seg}
                        pending = pending[m.end():]
                        in_think_tag = False
                    else:
                        # 保留可能是不完整闭合标签的尾部
                        safe_len = max(0, len(pending) - 12)
                        seg = pending[:safe_len]
                        if seg:
                            full_thinking += seg
                            yield {"type": "thinking", "text": seg}
                        pending = pending[safe_len:]
                        break
                else:
                    m = THINK_OPEN.search(pending)
                    if m:
                        seg = pending[:m.start()]
                        if seg:
                            full_content += seg
                            yield {"type": "content", "text": seg}
                        pending = pending[m.end():]
                        in_think_tag = True
                    else:
                        safe_len = max(0, len(pending) - 12)
                        # 只有当尾部可能是标签开头时才保留缓冲
                        if "<" in pending[safe_len:]:
                            seg = pending[:safe_len]
                        else:
                            seg = pending
                        if seg:
                            full_content += seg
                            yield {"type": "content", "text": seg}
                        pending = pending[len(seg):]
                        break
    except Exception as e:
        diag.log_exception(
            "backend.llm", "流式读取中断", e,
            model=model,
            received_chars=len(full_content),
            thinking_chars=len(full_thinking),
            elapsed_ms=timer.elapsed_ms(),
        )
        yield {"type": "error", "message": str(e)}
        return

    # 冲刷缓冲
    if pending:
        if in_think_tag:
            full_thinking += pending
            yield {"type": "thinking", "text": pending}
        else:
            full_content += pending
            yield {"type": "content", "text": pending}

    tool_calls = assembler.finish()
    done_meta = {
        "model": model,
        "content_chars": len(full_content),
        "thinking_chars": len(full_thinking),
        "elapsed_ms": timer.elapsed_ms(),
    }
    if tool_calls:
        done_meta["tool_calls"] = [call["name"] for call in tool_calls]
    response_preview = diag.verbose_preview(full_content)
    if response_preview:
        done_meta["response_preview"] = response_preview
    if not full_content.strip() and not tool_calls:
        # 上游返回空正文是常见故障，单独提级方便在日志里一眼看到。
        # 但要求执行工具的那一轮本来就可能没有正文，不算异常。
        diag.log_event("WARNING", "backend", "流式对话结束但正文为空", logger="backend.llm", **done_meta)
    else:
        diag.log_event("INFO", "backend", "流式对话完成", logger="backend.llm", **done_meta)

    yield {
        "type": "turn_done",
        "content": full_content,
        "thinking": full_thinking,
        "tool_calls": tool_calls,
    }


def stream_chat(
    settings: dict,
    model: str,
    api_messages: list[dict],
    tool_schemas: list[dict] | None = None,
    run_tool=None,
    effort: str | None = None,
) -> Generator[dict, None, None]:
    """带工具调用循环的流式对话。

    产出事件字典：
    {"type": "thinking", "text": ...}
    {"type": "content", "text": ...}
    {"type": "tool_start", "call_id": ..., "tool": ..., "arguments": {...}}
    {"type": "tool_progress", "call_id": ..., ...}   透传工具执行过程中的进度
    {"type": "tool_end", "call_id": ..., "tool": ..., "display": {...}}
    {"type": "tool_error", "call_id": ..., "tool": ..., "message": ...}
    {"type": "error", "message": ...}
    {"type": "done", "content": 完整正文, "thinking": 完整思考, "tool_calls": [...]}

    run_tool 由调用方注入，签名与 tools.execute 一致，即
    (name, arguments) -> Generator[进度, None, {"content", "display"}]。
    没有可用工具时行为与改造前完全一致：只发一次请求。
    """
    # messages 会在循环中追加 assistant/tool 消息，复制一份避免污染调用方的列表。
    messages = list(api_messages)
    content_parts: list[str] = []
    thinking_parts: list[str] = []
    tool_records: list[dict] = []

    for round_index in range(MAX_TOOL_ROUNDS + 1):
        # 到达上限后去掉 tools，逼模型用已有信息作答，而不是继续调用。
        exhausted = round_index >= MAX_TOOL_ROUNDS
        turn = None
        for event in _stream_once(
            settings, model, messages, None if exhausted else tool_schemas,
            effort=effort,
        ):
            if event["type"] == "turn_done":
                turn = event
            elif event["type"] == "error":
                yield event
                return
            else:
                if event["type"] == "content":
                    content_parts.append(event["text"])
                elif event["type"] == "thinking":
                    thinking_parts.append(event["text"])
                yield event

        if turn is None:
            yield {"type": "error", "message": "上游未返回完整响应"}
            return

        calls = turn["tool_calls"]
        if not calls or run_tool is None:
            if calls and run_tool is None:
                diag.log_event(
                    "WARNING", "backend", "模型请求工具但未提供执行器",
                    logger="backend.llm", tools=[call["name"] for call in calls],
                )
            break

        # 把这一轮的工具调用按原样记进历史，模型下一轮才能对上 tool_call_id。
        messages.append({
            "role": "assistant",
            "content": turn["content"] or None,
            "tool_calls": [
                {
                    "id": call["id"],
                    "type": "function",
                    "function": {"name": call["name"], "arguments": call["arguments"] or "{}"},
                }
                for call in calls
            ],
        })

        for call in calls:
            record = {
                "call_id": call["id"],
                "tool": call["name"],
                "arguments": call["parsed"] if call["parsed"] is not None else {},
            }
            yield {"type": "tool_start", **record}

            if call["parsed"] is None:
                message = "参数不是合法 JSON，请重新调用"
                yield {"type": "tool_error", **record, "message": message}
                messages.append({
                    "role": "tool", "tool_call_id": call["id"], "content": f"错误：{message}",
                })
                tool_records.append({**record, "error": message})
                continue

            try:
                generator = run_tool(call["name"], call["parsed"])
                result = yield from _forward_tool_progress(generator, call["id"])
            except Exception as error:
                # 工具失败不该终止对话：把错误回填给模型，让它换个说法或直接作答。
                message = str(error)
                diag.log_event(
                    "WARNING", "backend", "工具执行失败", logger="backend.llm",
                    tool=call["name"], error_type=type(error).__name__, error=message,
                )
                yield {"type": "tool_error", **record, "message": message}
                messages.append({
                    "role": "tool", "tool_call_id": call["id"], "content": f"错误：{message}",
                })
                tool_records.append({**record, "error": message})
                continue

            display = result.get("display") or {}
            yield {"type": "tool_end", **record, "display": display}
            messages.append({
                "role": "tool", "tool_call_id": call["id"], "content": result.get("content") or "",
            })
            tool_records.append({**record, "display": display})

    yield {
        "type": "done",
        "content": "".join(content_parts),
        "thinking": "".join(thinking_parts),
        "tool_calls": tool_records,
    }


def _forward_tool_progress(generator, call_id: str):
    """把工具执行中的进度事件转发出去，并返回它的最终结果。"""
    result = None
    try:
        while True:
            progress = next(generator)
            # 工具自己的 type 字段不能覆盖外层事件类型。
            payload = {k: v for k, v in progress.items() if k != "type"}
            yield {"type": "tool_progress", "call_id": call_id, **payload}
    except StopIteration as stop:
        result = stop.value or {}
    return result
