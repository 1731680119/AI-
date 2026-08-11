"""联网搜索：把 DeepSeek Responses API 的服务端内置 web_search 包装成一个工具。

为什么单独走一个上游：主对话模型（Claude 等）通过 /chat/completions 调用，
只能声明「客户端自己执行」的 function 工具；而 DeepSeek 的 web_search 是
服务端执行的内置工具，只挂在 /responses 上。因此这里把搜索做成旁路——
主模型发出 web_search 调用，后端转手请求 DeepSeek 跑一趟，再把带来源的
结果回填给主模型继续写。附带的好处是主对话仍可使用附件与图片，
而 Responses 的输入不支持这些。

DeepSeek 的实测行为（与官方文档有出入的部分）：
  * annotations 恒为空数组，来源只以裸 URL 写在正文里，因此来源列表以
    web_search_call 里 action.type == "open_page" 的 url 为准，那是模型
    真正读过的页面。
  * open_page 的 url 尾部会被追加 #ws_call_id=...，展示前需要剥掉。
  * 一次问答可能产生十多个 web_search_call，输入 token 会涨到普通对话的
    十几倍，所以调用方需要对轮次与预算设限。
"""
import json
import re
import urllib.error
import urllib.request
from typing import Any
from typing import Generator

import logging_config as diag


DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-flash"
REQUEST_TIMEOUT_SECONDS = 240

# 服务端把搜索到的网页正文塞进上下文，这里限制单次搜索的输出预算，
# 避免一次提问把费用推得过高。
DEFAULT_MAX_OUTPUT_TOKENS = 4000

_WS_CALL_FRAGMENT = re.compile(r"#ws_call_id=[^#\s]*$")
_BARE_URL = re.compile(r"(?<!\()(?<!\])https?://[^\s<>\"）】，。；]+")

TOOL_NAME = "web_search"

# 交给主对话模型的工具声明。描述里写清「返回带来源的检索结果」，
# 模型才会在需要时主动调用，而不是凭记忆回答。
TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": (
            "联网搜索并返回带来源链接的检索结果。"
            "当问题涉及实时信息、近期事件、具体数据或你不确定的事实时使用。"
            "查询语句请使用自然语言，可以直接写用户的问题。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "要搜索的问题或关键词，使用自然语言。",
                },
            },
            "required": ["query"],
        },
    },
}


def is_configured(settings: dict) -> bool:
    """关掉联网开关、或没有配搜索密钥时，不把工具声明发给模型。

    否则模型会调用一个必然失败的工具。tools_enabled 只管联网搜索这一个工具，
    别的工具（如长期记忆）各有自己的开关。
    """
    if not settings.get("tools_enabled", True):
        return False
    return bool((settings.get("search_api_key") or "").strip())


def strip_call_fragment(url: str) -> str:
    """去掉 DeepSeek 追加在 open_page URL 尾部的 #ws_call_id=... 片段。"""
    return _WS_CALL_FRAGMENT.sub("", url or "")


def linkify_bare_urls(text: str) -> str:
    """把正文里的裸 URL 转成 markdown 链接，让前端渲染成可点击的来源。"""
    return _BARE_URL.sub(lambda m: f"[{m.group(0)}]({m.group(0)})", text or "")


def _endpoint(settings: dict) -> str:
    base = (settings.get("search_base_url") or DEFAULT_BASE_URL).strip().rstrip("/")
    # 允许用户按习惯填带 /v1 的地址；Responses 挂在根路径上。
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return f"{base}/responses"


def _request_body(settings: dict, query: str, stream: bool) -> dict:
    return {
        "model": (settings.get("search_model") or DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        "instructions": (
            "你是检索助手。使用联网搜索核实信息，然后用中文简洁作答。"
            "必须在末尾列出所引用页面的标题与完整 URL。不要编造来源。"
        ),
        "input": query,
        "tools": [{"type": "web_search"}],
        "max_output_tokens": max(
            int(settings.get("search_max_output_tokens") or DEFAULT_MAX_OUTPUT_TOKENS), 512
        ),
        "stream": stream,
    }


def _post(settings: dict, body: dict):
    payload = json.dumps(body, ensure_ascii=False).encode("utf8")
    request = urllib.request.Request(
        _endpoint(settings),
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {(settings.get('search_api_key') or '').strip()}",
        },
    )
    return urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS)


def _describe_action(action: dict) -> dict:
    """把 web_search_call 的 action 归一成前端能直接显示的形状。"""
    kind = (action or {}).get("type") or ""
    if kind == "open_page":
        url = strip_call_fragment(action.get("url") or "")
        return {"action": "open_page", "url": url, "queries": []}
    return {
        "action": "search",
        "url": "",
        # queries 里混有一个 ws_call_id=... 的伪查询，过滤掉再展示。
        "queries": [q for q in (action.get("queries") or []) if not q.startswith("ws_call_id=")],
    }


def _collect_sources(pages: list[str]) -> list[dict]:
    """来源列表以模型实际打开过的页面为准，按出现顺序去重。"""
    sources: list[dict] = []
    seen: set[str] = set()
    for url in pages:
        if not url or url in seen:
            continue
        seen.add(url)
        host = ""
        match = re.match(r"https?://([^/]+)", url)
        if match:
            host = match.group(1)
        sources.append({"url": url, "host": host})
    return sources


def _iter_sse(response) -> Generator[dict, None, None]:
    """解析 Responses 的语义化事件流。

    与 /chat/completions 不同，这里没有 data: [DONE]，流以
    response.completed / response.incomplete / response.failed 结束。
    event: 行给出事件名，data: 行里通常也带 type，取其一即可。
    """
    event_name = ""
    for raw in response:
        line = raw.decode("utf8", "replace").rstrip("\r\n")
        if line.startswith("event:"):
            event_name = line[6:].strip()
        elif line.startswith("data:"):
            chunk = line[5:].strip()
            if not chunk:
                continue
            try:
                payload = json.loads(chunk)
            except json.JSONDecodeError:
                continue
            if not payload.get("type") and event_name:
                payload["type"] = event_name
            yield payload


def search(settings: dict, query: str) -> Generator[dict, None, None]:
    """执行一次联网搜索，边跑边产出进度事件，最后产出结果。

    产出的事件：
      {"type": "progress", "action": "search"|"open_page", "queries": [...], "url": ...}
      {"type": "result", "text": 检索结论, "sources": [...], "usage": {...}}
      {"type": "error", "message": ...}
    """
    timer = diag.Timer()
    diag.log_event(
        "INFO", "backend", "开始联网搜索", logger="backend.web_search",
        query_chars=len(query),
        base_url=_endpoint(settings),
        api_key=diag.mask_secret(settings.get("search_api_key")),
    )

    try:
        response = _post(settings, _request_body(settings, query, stream=True))
    except urllib.error.HTTPError as error:
        detail = error.read()[:500].decode("utf8", "replace")
        diag.log_event(
            "ERROR", "backend", "联网搜索请求被拒绝", logger="backend.web_search",
            status=error.code, detail=detail, elapsed_ms=timer.elapsed_ms(),
        )
        yield {"type": "error", "message": f"搜索服务返回 {error.code}：{detail}"}
        return
    except Exception as error:
        diag.log_exception(
            "backend.web_search", "联网搜索请求失败", error, elapsed_ms=timer.elapsed_ms()
        )
        yield {"type": "error", "message": str(error)}
        return

    text_parts: list[str] = []
    pages: list[str] = []
    usage: dict[str, Any] = {}
    call_count = 0
    failure = ""
    truncated = ""

    try:
        for event in _iter_sse(response):
            kind = event.get("type") or ""

            if kind == "response.output_text.delta":
                text_parts.append(event.get("delta") or "")

            elif kind == "response.output_item.done":
                item = event.get("item") or {}
                if item.get("type") == "web_search_call":
                    call_count += 1
                    described = _describe_action(item.get("action") or {})
                    if described["action"] == "open_page" and described["url"]:
                        pages.append(described["url"])
                    yield {"type": "progress", **described}

            elif kind in ("response.completed", "response.incomplete", "response.failed"):
                payload = event.get("response") or {}
                usage = payload.get("usage") or {}
                if kind == "response.failed":
                    failure = str((payload.get("error") or {}).get("message") or "搜索失败")
                elif kind == "response.incomplete":
                    # 达到 max_output_tokens 时仍有部分结论可用，不当作失败。
                    truncated = (payload.get("incomplete_details") or {}).get("reason") or "截断"
                    diag.log_event(
                        "WARNING", "backend", "联网搜索输出被截断",
                        logger="backend.web_search", reason=truncated,
                        reasoning_tokens=(usage.get("output_tokens_details") or {}).get(
                            "reasoning_tokens"
                        ),
                    )
                # 兜底：流式漏收 open_page 时，从最终 response 的 output 里补齐来源。
                for item in payload.get("output") or []:
                    if item.get("type") != "web_search_call":
                        continue
                    described = _describe_action(item.get("action") or {})
                    if described["action"] == "open_page" and described["url"]:
                        pages.append(described["url"])
    except Exception as error:
        diag.log_exception(
            "backend.web_search", "联网搜索流中断", error,
            received_chars=sum(len(part) for part in text_parts),
            elapsed_ms=timer.elapsed_ms(),
        )
        if not text_parts:
            yield {"type": "error", "message": str(error)}
            return
        failure = ""

    if failure:
        yield {"type": "error", "message": failure}
        return

    text = "".join(text_parts).strip()
    sources = _collect_sources(pages)
    diag.log_event(
        "INFO", "backend", "联网搜索完成", logger="backend.web_search",
        result_chars=len(text), source_count=len(sources), tool_calls=call_count,
        input_tokens=usage.get("input_tokens"), output_tokens=usage.get("output_tokens"),
        elapsed_ms=timer.elapsed_ms(),
    )
    if not text:
        # 思维链会占用 max_output_tokens。预算偏紧时可能整段预算都被思考吃掉，
        # 一个字正文都没剩下。把原因写清楚，模型才知道该换个更窄的查询重试。
        if truncated:
            yield {
                "type": "error",
                "message": (
                    f"搜索输出在产生结论前被{truncated}截断（思考占用了全部输出预算）。"
                    "可以缩小查询范围重试，或在设置里提高搜索输出预算。"
                ),
            }
        else:
            yield {"type": "error", "message": "搜索没有返回结论"}
        return
    yield {"type": "result", "text": text, "sources": sources, "usage": usage}
