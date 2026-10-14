"""联网搜索适配层。

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

搜索配置可以存多套（官方直连 + 各家中转站），本模块只认一条扁平的 provider
字典，由 active_provider() 从设置里挑出当前选中的那条；设置页的检测按钮则
直接把未保存的草稿传进来跑 test_provider()。
"""
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any
from typing import Generator

import logging_config as diag


DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-flash"
REQUEST_TIMEOUT_SECONDS = 240

# 设置页「检测」按钮用的超时。检测要的是「能不能用」这个结论，
# 不必等一次完整的深度检索，卡太久用户会以为界面死了。
TEST_TIMEOUT_SECONDS = 120

# 检测用的固定查询：必须联网才答得出，凭记忆答不了，
# 这样「有没有真的联网」就能从有没有来源链接看出来。
TEST_QUERY = "今天是几月几日？请顺便给出一条今天的新闻标题。"

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
            "以下情况必须使用此工具："
            "1. 问题涉及实时信息、近期事件、具体数据、价格、产品型号、公司名单、厂商列表"
            "2. 问题需要列举具体的厂商、品牌、机构、地点"
            "3. 问题要求推荐、对比、排名"
            "4. 你对答案不够确定，或需要核实事实"
            "优先使用搜索，而不是依赖训练数据中的陈旧信息。"
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


def active_provider(settings: dict) -> dict:
    """取出当前选中的那套搜索配置。

    配置以列表形式保存（search_providers），search_provider_id 指向正在用的
    一条。这里只负责挑出来并补全缺省值，其余函数一律只认这个扁平的 provider
    字典，不再直接读 settings，检测接口才能用「还没保存的草稿」跑一次。
    """
    providers = [p for p in (settings.get("search_providers") or []) if isinstance(p, dict)]
    current = None
    for item in providers:
        if str(item.get("id") or "") == str(settings.get("search_provider_id") or ""):
            current = item
            break
    if current is None and providers:
        current = providers[0]
    return normalize_provider(current or {})


def normalize_provider(provider: dict) -> dict:
    """把一条配置补齐成后续代码可以直接用的形状。"""
    provider = provider or {}
    try:
        budget = int(provider.get("max_output_tokens") or DEFAULT_MAX_OUTPUT_TOKENS)
    except (TypeError, ValueError):
        budget = DEFAULT_MAX_OUTPUT_TOKENS
    base_url = (str(provider.get("base_url") or "").strip() or DEFAULT_BASE_URL)
    name = str(provider.get("name") or "未命名配置")
    protocol = str(provider.get("protocol") or "").strip().lower()
    if protocol not in {"deepseek", "qwen", "kimi", "glm"}:
        probe = f"{name} {base_url}".lower()
        protocol = (
            "qwen" if any(x in probe for x in ("qwen", "千问", "dashscope", "aliyun")) else
            "kimi" if any(x in probe for x in ("kimi", "moonshot")) else
            "glm" if any(x in probe for x in ("glm", "智谱", "bigmodel")) else
            "deepseek"
        )
    return {
        "id": str(provider.get("id") or ""),
        "name": name,
        "protocol": protocol,
        "base_url": base_url,
        "api_key": str(provider.get("api_key") or "").strip(),
        "model": (str(provider.get("model") or "").strip() or DEFAULT_MODEL),
        "max_output_tokens": max(budget, 512),
    }


def is_configured(settings: dict) -> bool:
    """关掉联网开关、或当前配置没有密钥时，不把工具声明发给模型。

    否则模型会调用一个必然失败的工具。tools_enabled 只管联网搜索这一个工具，
    别的工具（如长期记忆）各有自己的开关。
    """
    if not settings.get("tools_enabled", True):
        return False
    return bool(active_provider(settings)["api_key"])


def protocol(provider: dict) -> str:
    """返回官方搜索协议；旧配置没有 protocol 时按地址和名称推断。"""
    return normalize_provider(provider)["protocol"]


def strip_call_fragment(url: str) -> str:
    """去掉 DeepSeek 追加在 open_page URL 尾部的 #ws_call_id=... 片段。"""
    return _WS_CALL_FRAGMENT.sub("", url or "")


def linkify_bare_urls(text: str) -> str:
    """把正文里的裸 URL 转成 markdown 链接，让前端渲染成可点击的来源。"""
    return _BARE_URL.sub(lambda m: f"[{m.group(0)}]({m.group(0)})", text or "")


# 路径不对时上游给的状态码。碰到这些就换下一个候选路径重试。
# 403 也算：中转站的网站根路径往往挂在 Cloudflare 后面，POST 一个不存在的
# 接口会被 WAF 拦成 403（error code 1010）而不是 404。
# 401（密钥问题）、5xx（上游故障）不在此列，换路径也没用。
_PATH_MISMATCH_CODES = {403, 404, 405, 501}

# 浏览器味的 UA。默认的 Python-urllib 会被一些中转站前面的 WAF 直接拦掉。
_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AI-Chatbot/1.0"

# 记住每个 base_url 上一次成功的完整地址，省掉之后每次搜索都先撞一次 404。
# 进程内缓存即可，设置改了会换 key，重启后重新探一次也不算贵。
_ENDPOINT_CACHE: dict[str, str] = {}


class EndpointError(Exception):
    """所有候选路径都不成立。message 里带上每个候选各自的失败原因。"""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def endpoint_candidates(base_url: str) -> list[str]:
    """给出要依次尝试的完整请求地址。

    官方地址（https://api.deepseek.com）的 Responses 挂在根路径上，而中转站
    （one-api / new-api 等）通常原样转发成 <base>/v1/responses。用户按各家文档
    抄来的 Base URL 带不带 /v1 都有，所以这里不做假设，两种都试。
    """
    base = (base_url or "").strip().rstrip("/") or DEFAULT_BASE_URL
    if base.endswith("/responses"):
        # 用户直接把完整接口地址粘进来了，照用不猜。
        return [base]
    if base.endswith("/v1"):
        return [f"{base[: -len('/v1')]}/responses", f"{base}/responses"]
    return [f"{base}/responses", f"{base}/v1/responses"]


def _ordered_candidates(provider: dict) -> list[str]:
    """把上次成功的地址排到最前面，其余保持原顺序。"""
    candidates = endpoint_candidates(provider.get("base_url"))
    if protocol(provider) == "qwen":
        candidates.sort(key=lambda url: "/v1/responses" not in url)
    cached = _ENDPOINT_CACHE.get(provider.get("base_url") or "")
    if cached and cached in candidates:
        return [cached] + [url for url in candidates if url != cached]
    return candidates


def _request_body(provider: dict, query: str, stream: bool) -> dict:
    return {
        "model": provider["model"],
        "instructions": (
            "你是检索助手。使用联网搜索核实信息，然后用中文简洁作答。"
            "必须在末尾列出所引用页面的标题与完整 URL。不要编造来源。"
        ),
        "input": query,
        "tools": [{"type": "web_search"}],
        "max_output_tokens": provider["max_output_tokens"],
        "stream": stream,
    }


def _post_to(url: str, provider: dict, body: dict, timeout: int):
    payload = json.dumps(body, ensure_ascii=False).encode("utf8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {provider['api_key']}",
        "User-Agent": _USER_AGENT,
        "Accept": "text/event-stream, application/json",
    }
    if protocol(provider) == "qwen":
        # DashScope 原生流式接口需要这个请求头；缺少时部分地域会退回普通正文。
        headers["X-DashScope-SSE"] = "enable"
    request = urllib.request.Request(
        url,
        data=payload,
        headers=headers,
    )
    return urllib.request.urlopen(request, timeout=timeout)


def _post(provider: dict, body: dict, timeout: int) -> tuple[Any, str]:
    """按候选路径依次尝试，返回 (响应, 实际用的地址)。

    判定「这个路径不对」有两种情况：一是状态码属于 _PATH_MISMATCH_CODES；
    二是状态码 200 但回的不是接口响应——中转站的根路径通常是它自己的管理站，
    POST 过去会返回一整页 HTML，这时继续读下去只会解析出空结果。
    其它错误（密钥不对、上游故障）直接停下，换路径也没用。
    """
    candidates = _ordered_candidates(provider)
    attempts: list[str] = []
    last_status = 0
    for index, url in enumerate(candidates):
        is_last = index == len(candidates) - 1
        try:
            response = _post_to(url, provider, body, timeout)
        except urllib.error.HTTPError as error:
            detail = error.read()[:300].decode("utf8", "replace").strip()
            attempts.append(f"{url} → HTTP {error.code} {detail}")
            last_status = error.code
            if error.code in _PATH_MISMATCH_CODES and not is_last:
                diag.log_event(
                    "INFO", "backend", "搜索接口路径不匹配，换一个候选重试",
                    logger="backend.web_search", tried=url, status=error.code,
                    next_url=candidates[index + 1],
                )
                continue
            raise EndpointError(_attempt_summary(attempts), last_status) from error

        content_type = (response.headers.get("Content-Type") or "").lower()
        if "json" not in content_type and "event-stream" not in content_type:
            response.close()
            attempts.append(f"{url} → 返回 {content_type or '未知类型'}，不是接口响应")
            if not is_last:
                diag.log_event(
                    "INFO", "backend", "搜索接口返回的不是接口响应，换一个候选重试",
                    logger="backend.web_search", tried=url, content_type=content_type,
                    next_url=candidates[index + 1],
                )
                continue
            raise EndpointError(_attempt_summary(attempts), 0)

        _ENDPOINT_CACHE[provider.get("base_url") or ""] = url
        return response, url
    raise EndpointError(_attempt_summary(attempts), last_status)


def _attempt_summary(attempts: list[str]) -> str:
    """把每个候选路径各自的失败原因拼成一条给人看的消息。"""
    if len(attempts) == 1:
        return f"搜索接口不可用：{attempts[0]}"
    lines = "；".join(attempts)
    return f"试过的接口地址都不可用：{lines}"


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


def _source_rows(rows: list[dict]) -> list[dict]:
    """只接受接口给出的 HTTP(S) 来源，保留标题；不从模型正文猜来源。"""
    sources = []
    seen = set()
    for row in rows:
        if isinstance(row, str):
            citation = {"url": row}
        elif isinstance(row, dict):
            citation = row.get("url_citation") or row
        else:
            continue
        url = strip_call_fragment(str(citation.get("url") or citation.get("link") or ""))
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or url in seen:
            continue
        seen.add(url)
        sources.append({"url": url, "host": parsed.netloc,
                        "title": str(citation.get("title") or ""),
                        "date": str(citation.get("date") or citation.get("publish_date") or "")})
    return sources


def _response_sources(item: dict) -> list[dict]:
    rows = list((item.get("action") or {}).get("sources") or [])
    for part in item.get("content") or []:
        if isinstance(part, dict):
            rows.extend(part.get("annotations") or [])
    return rows


def _json_endpoint(provider: dict, suffix: str) -> str:
    base = provider["base_url"].rstrip("/")
    if base.endswith(suffix):
        return base
    for tail in ("/chat/completions", "/responses", "/tools/search", "/tools/search_pro", "/web_search"):
        if base.endswith(tail):
            base = base[:-len(tail)]
            break
    if protocol(provider) == "kimi" and not base.endswith("/v1"):
        base += "/v1"
    if protocol(provider) == "glm" and urllib.parse.urlsplit(base).path in {"", "/", "/api"}:
        base = base.rstrip("/") + ("/paas/v4" if base.endswith("/api") else "/api/paas/v4")
    return base + suffix


def _dashscope_endpoint(provider: dict) -> str:
    """按模型类型返回 DashScope 文本或多模态 Generation API 地址。"""
    base = provider["base_url"].rstrip("/")
    service_tails = (
        "/services/aigc/text-generation/generation",
        "/services/aigc/multimodal-generation/generation",
    )
    for service_tail in service_tails:
        if base.endswith(service_tail):
            base = base[:-len(service_tail)]
            break
    for tail in ("/chat/completions", "/responses", "/compatible-mode/v1", "/compatible-mode", "/api/v1", "/v1"):
        if base.endswith(tail):
            base = base[:-len(tail)]
            break
    return base + "/api/v1" + _dashscope_service_tail(provider)


def _dashscope_is_multimodal(provider: dict) -> bool:
    model = str(provider.get("model") or "").lower().replace("_", "-")
    return any(marker in model for marker in ("qwen3.5", "qwen3.6", "qwen3.7", "qwen3.8"))


def _dashscope_service_tail(provider: dict) -> str:
    kind = "multimodal-generation" if _dashscope_is_multimodal(provider) else "text-generation"
    return f"/services/aigc/{kind}/generation"


def _dashscope_host_supported(provider: dict) -> bool:
    host = (urllib.parse.urlsplit(provider["base_url"]).hostname or "").lower()
    return host == "dashscope.aliyuncs.com" or host.endswith(".maas.aliyuncs.com")


def _dashscope_body(provider: dict, query: str) -> dict:
    multimodal = _dashscope_is_multimodal(provider)
    instruction = (
        "你是检索助手。使用联网搜索核实信息，然后用中文简洁作答。"
        "必须在末尾列出引用页面的标题与完整 URL，不要编造来源。\n\n"
    )
    search_strategy = "agent" if "omni" in str(provider.get("model") or "").lower() else "max"
    return {
        "model": provider["model"],
        "input": {"messages": [
            {"role": "user", "content": (
                [{"text": instruction + query}] if multimodal else instruction + query
            )},
        ]},
        "parameters": {
            "enable_search": True,
            "search_options": {
                "forced_search": True,
                "search_strategy": search_strategy,
                "enable_source": True,
            },
            "result_format": "message",
            "stream": True,
            "incremental_output": True,
        },
    }


def _dashscope_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
        return "".join(parts)
    return ""


def _iter_dashscope(response) -> Generator[dict, None, None]:
    """解析 DashScope 兼容模式的 data:{output:...} SSE。"""
    for raw in response:
        line = raw.decode("utf8", "replace").strip()
        chunk = line[5:].strip() if line.startswith("data:") else line
        if not chunk or chunk == "[DONE]":
            continue
        try:
            payload = json.loads(chunk)
        except json.JSONDecodeError:
            continue
        yield payload


def _dashscope_search_rows(payload: dict) -> list[dict]:
    """兼容 DashScope 不同版本把 search_info 放在 output 或 message 的情况。"""
    rows: list[dict] = []
    output = payload.get("output") or {}
    for container in (
        payload,
        output,
        payload.get("message") or {},
        output.get("message") or {},
    ):
        if isinstance(container, dict):
            info = container.get("search_info") or {}
            if isinstance(info, dict):
                rows.extend(info.get("search_results") or [])
    for choice in (output.get("choices") or payload.get("choices") or []):
        if not isinstance(choice, dict):
            continue
        for container in (choice, choice.get("message") or {}, choice.get("delta") or {}):
            if isinstance(container, dict):
                info = container.get("search_info") or {}
                if isinstance(info, dict):
                    rows.extend(info.get("search_results") or [])
    return rows


def _search_dashscope(provider: dict, query: str, timeout: int):
    """调用千问 DashScope 原生文本或多模态 Generation API 联网搜索。"""
    endpoint = _dashscope_endpoint(provider)
    yield {"type": "progress", "action": "search", "queries": [query], "url": ""}
    if not _dashscope_host_supported(provider):
        yield {
            "type": "error",
            "status": 0,
            "message": (
                "此 Base URL 不是阿里云 DashScope 原生 API 域名，无法通过它调用联网搜索。"
                "请在阿里云百炼控制台复制当前地域的业务空间 Base URL，例如 "
                "https://<业务空间ID>.cn-beijing.maas.aliyuncs.com/api/v1，"
                "再把协议设为“千问 DashScope”。OpenAI 兼容中转站不提供 DashScope 原生搜索来源。"
            ),
        }
        return
    try:
        response = _post_to(endpoint, provider, _dashscope_body(provider, query), timeout)
    except urllib.error.HTTPError as error:
        detail = error.read(2048).decode("utf8", "replace")
        yield {"type": "error", "message": f"DashScope 搜索接口 HTTP {error.code}：{detail}", "status": error.code}
        return
    except Exception as error:
        yield {"type": "error", "message": str(error), "status": 0}
        return

    text_parts: list[str] = []
    rows: list[dict] = []
    usage: dict[str, Any] = {}
    try:
        for payload in _iter_dashscope(response):
            output = payload.get("output") or {}
            choices = output.get("choices") or payload.get("choices") or []
            if choices:
                choice = choices[0] or {}
                message = choice.get("message") or {}
                delta = choice.get("delta") or {}
                text_parts.append(_dashscope_text(
                    message.get("content") or delta.get("content") or choice.get("text")
                ))
            rows.extend(_dashscope_search_rows(payload))
            usage = payload.get("usage") or usage
    finally:
        response.close()

    sources = _source_rows(rows)
    text = "".join(text_parts).strip()
    if not sources:
        yield {"type": "error", "message": "DashScope 已返回内容，但没有返回可验证的搜索来源", "status": 0}
        return
    if not text:
        text = "\n\n".join(
            f"标题：{row.get('title') or row.get('url') or row.get('link')}\n"
            f"链接：{row.get('url') or row.get('link')}\n"
            f"内容：{row.get('snippet') or row.get('content') or ''}"
            for row in rows if row.get("url") or row.get("link")
        )
    yield {
        "type": "result", "text": text[:provider["max_output_tokens"] * 3],
        "sources": sources, "usage": usage, "endpoint": endpoint,
        "tool_calls": 1, "search_verified": True,
    }


def _search_structured(provider: dict, query: str, timeout: int):
    kind = protocol(provider)
    yield {"type": "progress", "action": "search", "queries": [query], "url": ""}
    if kind == "kimi":
        endpoint = _json_endpoint(provider, "/tools/search")
        body = {"text_query": query, "limit": 6, "include_content": True,
                "timeout_seconds": min(timeout, 60)}
    else:
        endpoint = _json_endpoint(provider, "/web_search")
        if len(query) > 70:
            yield {"type": "error", "message": "GLM 搜索词最多 70 个字符，请缩短查询后重试", "status": 0}
            return
        body = {"search_query": query, "search_engine": "search_pro", "search_intent": False,
                "count": 6, "content_size": "high"}
    try:
        with _post_to(endpoint, provider, body, timeout) as response:
            payload = json.load(response)
        if payload.get("error"):
            raise ValueError(str(payload["error"].get("message") or payload["error"]))
        rows = payload.get("search_results" if kind == "kimi" else "search_result") or []
        sources = _source_rows(rows)
        if not sources:
            yield {"type": "error", "message": "搜索接口未返回网页结果，请更换查询词", "status": 0}
            return
        blocks = []
        for row in rows:
            url = row.get("url") or row.get("link") or ""
            if url not in {s["url"] for s in sources}:
                continue
            text = row.get("text") or row.get("content") or row.get("snippet") or ""
            blocks.append(f"标题：{row.get('title') or url}\n链接：{url}\n内容：{text[:3500]}")
        # 搜索正文属于不可信网页数据，主模型应只把它作为资料。
        text = "\n\n".join(blocks)[:provider["max_output_tokens"] * 3]
        yield {"type": "result", "text": text, "sources": sources, "usage": {},
               "endpoint": endpoint, "tool_calls": 1, "search_verified": True}
    except urllib.error.HTTPError as error:
        detail = error.read(2048).decode("utf8", "replace")
        yield {"type": "error", "message": f"搜索接口 HTTP {error.code}：{detail}", "status": error.code}
    except Exception as error:
        yield {"type": "error", "message": str(error), "status": 0}


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


def _search_responses(
    provider: dict, query: str, timeout: int = REQUEST_TIMEOUT_SECONDS
) -> Generator[dict, None, None]:
    """执行一次联网搜索，边跑边产出进度事件，最后产出结果。

    provider 是一条已经归一化的搜索配置（见 normalize_provider），不是 settings：
    检测接口要用「还没保存的草稿」跑，所以这一层不碰全局设置。

    产出的事件：
      {"type": "progress", "action": "search"|"open_page", "queries": [...], "url": ...}
      {"type": "result", "text": 检索结论, "sources": [...], "usage": {...}, "endpoint": ...}
      {"type": "error", "message": ..., "status": HTTP 状态码或 0}
    """
    timer = diag.Timer()
    diag.log_event(
        "INFO", "backend", "开始联网搜索", logger="backend.web_search",
        query_chars=len(query),
        provider=provider.get("name"),
        base_url=provider.get("base_url"),
        model=provider.get("model"),
        api_key=diag.mask_secret(provider.get("api_key")),
    )

    try:
        response, endpoint = _post(provider, _request_body(provider, query, stream=True), timeout)
    except EndpointError as error:
        diag.log_event(
            "ERROR", "backend", "联网搜索请求被拒绝", logger="backend.web_search",
            status=error.status, detail=str(error), elapsed_ms=timer.elapsed_ms(),
        )
        yield {"type": "error", "message": str(error), "status": error.status}
        return
    except Exception as error:
        diag.log_exception(
            "backend.web_search", "联网搜索请求失败", error, elapsed_ms=timer.elapsed_ms()
        )
        yield {"type": "error", "message": str(error), "status": 0}
        return

    text_parts: list[str] = []
    # 有的上游（尤其是中转站）不把正文放在 delta 里，只在 done 事件给整段。
    # 只在一个 delta 都没收到时才用它兜底，避免和正常流式重复计一遍。
    done_parts: list[str] = []
    pages: list[str] = []
    source_rows: list[dict] = []
    usage: dict[str, Any] = {}
    call_count = 0
    failure = ""
    truncated = ""

    try:
        for event in _iter_sse(response):
            kind = event.get("type") or ""

            if kind == "response.output_text.delta":
                text_parts.append(event.get("delta") or "")

            elif kind == "response.output_text.done":
                done_parts.append(event.get("text") or "")

            elif kind == "response.output_item.done":
                item = event.get("item") or {}
                source_rows.extend(_response_sources(item))
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
                    source_rows.extend(_response_sources(item))
                    if item.get("type") == "message" and not text_parts and not done_parts:
                        done_parts.extend(part.get("text") or "" for part in item.get("content") or []
                                          if part.get("type") == "output_text")
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
            yield {"type": "error", "message": str(error), "status": 0}
            return
        failure = ""
    finally:
        response.close()

    if failure:
        yield {"type": "error", "message": failure, "status": 0}
        return

    text = "".join(text_parts).strip() or "".join(done_parts).strip()
    sources = _source_rows(source_rows + [{"url": url} for url in pages])
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
                "status": 0,
                "message": (
                    f"搜索输出在产生结论前被{truncated}截断（思考占用了全部输出预算）。"
                    "可以缩小查询范围重试，或在设置里提高搜索输出预算。"
                ),
            }
        else:
            yield {"type": "error", "message": "搜索没有返回结论", "status": 0}
        return
    yield {
        "type": "result",
        "text": text,
        "sources": sources,
        "usage": usage,
        "endpoint": endpoint,
        "tool_calls": call_count,
        "search_verified": bool(call_count or source_rows),
    }


def search(provider: dict, query: str, timeout: int = REQUEST_TIMEOUT_SECONDS):
    """按配置选择官方协议，DeepSeek 官方不再提供内置搜索，禁止误报成功。"""
    provider = normalize_provider(provider)
    kind = protocol(provider)
    if kind == "deepseek" and urllib.parse.urlsplit(provider["base_url"]).hostname == "api.deepseek.com":
        yield {"type": "error", "status": 0, "message": (
            "DeepSeek 官方当前不支持内置联网搜索（Responses 的 web_search 会被忽略）。"
            "请在联网搜索设置中选择千问、Kimi 或 GLM 搜索服务；聊天仍可使用 DeepSeek。"
        )}
        return
    if kind == "qwen":
        yield from _search_dashscope(provider, query, timeout)
        return
    if kind in {"kimi", "glm"}:
        yield from _search_structured(provider, query, timeout)
        return
    for event in _search_responses(provider, query, timeout):
        if event["type"] == "result" and (not event.get("search_verified") or not event.get("sources")):
            yield {"type": "error", "status": 0, "message": (
                "上游返回了文字，但没有可验证的搜索结果与来源，无法确认真正联网。"
                "请检查模型是否支持搜索、协议选择及中转站的搜索转发能力。"
            )}
        else:
            yield event


def test_provider(provider: dict) -> dict:
    """用给定配置真跑一次搜索，回一份给人看的检测报告。

    判定标准是「有没有拿到来源链接」而不是「有没有出字」：中转站转发的模型
    经常能正常出文字却根本没执行服务端 web_search，只看文字会误判成可用。
    """
    provider = normalize_provider(provider)
    timer = diag.Timer()
    if not provider["api_key"]:
        return {
            "ok": False, "status": "error", "message": "没有填 API 密钥",
            "endpoint": "", "elapsed_ms": 0, "sources": [], "text": "", "tool_calls": 0,
        }

    result: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    progress = 0
    for event in search(provider, TEST_QUERY, timeout=TEST_TIMEOUT_SECONDS):
        if event["type"] == "progress":
            progress += 1
        elif event["type"] == "result":
            result = event
        elif event["type"] == "error":
            error = event

    elapsed = timer.elapsed_ms()
    if error or not result:
        message = (error or {}).get("message") or "搜索没有返回结论"
        if progress == 0 and not (error or {}).get("status"):
            # 请求本身通过了，却一次搜索都没发起：多半是这个上游根本不支持
            # 服务端内置的 web_search，光看报错文字看不出这一层。
            message += "（上游一次搜索都没执行，多半不支持内置 web_search）"
        return {
            "ok": False, "status": "error", "message": message,
            "http_status": (error or {}).get("status") or 0,
            "endpoint": _ENDPOINT_CACHE.get(provider["base_url"] or "", ""),
            "elapsed_ms": elapsed, "sources": [], "text": "", "tool_calls": progress,
        }

    sources = result.get("sources") or []
    tool_calls = result.get("tool_calls") or progress
    if not sources:
        return {
            "ok": False,
            "status": "no_sources",
            "message": (
                "上游有回话，但没有返回任何来源链接，"
                "说明它多半没有真正执行内置的 web_search（中转站常见）。"
            ),
            "endpoint": result.get("endpoint") or "",
            "elapsed_ms": elapsed,
            "sources": [],
            "text": (result.get("text") or "")[:600],
            "tool_calls": tool_calls,
        }
    return {
        "ok": True,
        "status": "ok",
        "message": f"联网检索正常，命中 {len(sources)} 个来源",
        "endpoint": result.get("endpoint") or "",
        "elapsed_ms": elapsed,
        "sources": sources,
        "text": (result.get("text") or "")[:600],
        "tool_calls": tool_calls,
    }

