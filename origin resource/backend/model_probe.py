"""按 Base URL + 密钥探测上游有哪些模型可用。

用途是设置页里的「检测可用模型」：用户从中转站文档里抄模型名很容易抄错，
而各家中转站上架的模型又天天变，手打一个名字发出去只会换来一句上游报错。
这里直接问上游要一份清单，让用户从里面挑。

两个函数分别对应两种「能用」：
  * list_models() 读 /models，拿到上游对外宣称的清单，不花钱；
  * test_model() 真发一次极短的对话请求，验证这个模型确实能调通——清单里
    列着但实际没有权限、或者已经下架的情况相当常见。

Base URL 带不带 /v1 都行，和联网搜索一样按候选依次尝试；上游返回 HTML
（中转站的管理站首页）时视为路径不对，继续试下一个。
"""
import json
import urllib.error
import urllib.request
from typing import Any

import logging_config as diag
import model_params


REQUEST_TIMEOUT_SECONDS = 30
TEST_TIMEOUT_SECONDS = 60

# 测试用的最短请求：只要上游肯回一个字，就说明这个模型名是通的。
TEST_PROMPT = "hi"
TEST_MAX_TOKENS = 16

_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AI-Chatbot/1.0"

# 路径不对时上游给的状态码，碰到就换下一个候选（同 web_search 的判断）。
# 403 只在读清单时算：中转站的网站根路径常挂在 Cloudflare 后面，GET 一个
# 不存在的接口会被 WAF 拦成 403。而 /chat/completions 的 403 通常是
# 「这个分组没有该模型的渠道」，换路径没用，报出原文更有用。
_PATH_MISMATCH_CODES = {403, 404, 405, 501}
_CHAT_MISMATCH_CODES = {404, 405, 501}


class ProbeError(Exception):
    """所有候选路径都不成立。message 里带上每个候选各自的失败原因。"""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def _candidates(base_url: str, suffix: str) -> list[str]:
    """给出要依次尝试的完整地址。

    用户填的 Base URL 有的带 /v1（OpenAI 风格中转站的常见写法），有的不带
    （DeepSeek 官方）。这里不做假设，两种都试。
    """
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return []
    if base.endswith(f"/{suffix}"):
        # 用户直接把完整接口地址粘进来了，照用不猜。
        return [base]
    if base.endswith("/v1"):
        return [f"{base}/{suffix}", f"{base[: -len('/v1')]}/{suffix}"]
    return [f"{base}/v1/{suffix}", f"{base}/{suffix}"]


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {(api_key or '').strip()}",
        "User-Agent": _USER_AGENT,
        "Accept": "application/json",
    }


def _opener() -> urllib.request.OpenerDirector:
    """探测专用的 opener：**只认环境变量里的代理，不读 Windows 注册表**。

    默认的 `urlopen` 走 `getproxies()`，在 Windows 上会把「Internet 选项」里
    那份系统代理也算进来；而真正发对话请求的 llm.py 用的是 openai/httpx，
    httpx 只认 HTTP_PROXY / HTTPS_PROXY 环境变量。两边不一致的后果很难查：
    系统里挂着一个早就不监听的代理（常见于装过加速器、代理软件退出后没清
    注册表）时，聊天照常能用，一点「获取模型清单 / 测试」就报
    `[WinError 10061] 目标计算机积极拒绝`——看着像上游挂了，其实请求根本没
    出本机。所以这里显式对齐 httpx 的行为，只吃环境变量。
    """
    return urllib.request.build_opener(
        urllib.request.ProxyHandler(urllib.request.getproxies_environment())
    )


def _request(url: str, api_key: str, body: dict | None, timeout: int) -> tuple[int, bytes, str]:
    data = json.dumps(body, ensure_ascii=False).encode("utf8") if body is not None else None
    request = urllib.request.Request(url, data=data, headers=_headers(api_key))
    with _opener().open(request, timeout=timeout) as response:
        content_type = (response.headers.get("Content-Type") or "").lower()
        return response.status, response.read(), content_type


def _fetch(
    base_url: str, suffix: str, api_key: str, body: dict | None, timeout: int
) -> tuple[dict, str]:
    """按候选路径依次请求，返回 (解析好的 JSON, 实际用的地址)。

    判定「这个路径不对」有两种：状态码属于该请求对应的 mismatch 集合；或者
    状态码 200 但回的是 HTML——中转站的根路径通常是它自己的管理站，POST/GET
    过去会返回一整页网页，继续解析只会得到空清单。
    """
    candidates = _candidates(base_url, suffix)
    if not candidates:
        raise ProbeError("没有填 API 地址")

    mismatch = _CHAT_MISMATCH_CODES if suffix.startswith("chat/") else _PATH_MISMATCH_CODES
    attempts: list[str] = []
    last_status = 0
    for index, url in enumerate(candidates):
        is_last = index == len(candidates) - 1
        try:
            _, raw, content_type = _request(url, api_key, body, timeout)
        except urllib.error.HTTPError as error:
            detail = error.read()[:300].decode("utf8", "replace").strip()
            attempts.append(f"{url} → HTTP {error.code} {detail}")
            last_status = error.code
            if error.code in mismatch and not is_last:
                continue
            raise ProbeError(_summary(attempts), last_status) from error
        except Exception as error:  # 连不上、超时、证书问题等
            attempts.append(f"{url} → {error}")
            if not is_last:
                continue
            raise ProbeError(_summary(attempts), 0) from error

        if "json" not in content_type:
            attempts.append(f"{url} → 返回 {content_type or '未知类型'}，不是接口响应")
            if not is_last:
                continue
            raise ProbeError(_summary(attempts), 0)

        try:
            payload = json.loads(raw.decode("utf8", "replace"))
        except json.JSONDecodeError as error:
            attempts.append(f"{url} → 响应不是合法 JSON")
            if not is_last:
                continue
            raise ProbeError(_summary(attempts), 0) from error
        return payload, url

    raise ProbeError(_summary(attempts), last_status)


def _summary(attempts: list[str]) -> str:
    if not attempts:
        return "请求失败"
    if len(attempts) == 1:
        return f"接口不可用：{attempts[0]}"
    return "试过的接口地址都不可用：" + "；".join(attempts)


def _extract_ids(payload: Any) -> list[str]:
    """从 /models 的响应里取出模型名。

    标准 OpenAI 格式是 {"data": [{"id": ...}]}，但中转站的实现五花八门：
    有直接给数组的，也有数组里放裸字符串的，都兼容一下。
    """
    items = payload
    if isinstance(payload, dict):
        for key in ("data", "models", "result"):
            if isinstance(payload.get(key), list):
                items = payload[key]
                break
    if not isinstance(items, list):
        return []

    ids: list[str] = []
    seen: set[str] = set()
    for item in items:
        if isinstance(item, str):
            name = item.strip()
        elif isinstance(item, dict):
            name = str(item.get("id") or item.get("name") or item.get("model") or "").strip()
        else:
            name = ""
        if name and name not in seen:
            seen.add(name)
            ids.append(name)
    return ids


def list_models(base_url: str, api_key: str) -> dict:
    """读取上游的模型清单。不发对话请求，所以不产生费用。"""
    timer = diag.Timer()
    diag.log_event(
        "INFO", "backend", "开始检测可用模型", logger="backend.model_probe",
        base_url=base_url, api_key=diag.mask_secret(api_key),
    )
    if not (base_url or "").strip():
        return {"ok": False, "message": "没有填 API 地址", "endpoint": "",
                "models": [], "elapsed_ms": 0, "http_status": 0}
    if not (api_key or "").strip():
        return {"ok": False, "message": "没有填 API 密钥", "endpoint": "",
                "models": [], "elapsed_ms": 0, "http_status": 0}

    try:
        payload, endpoint = _fetch(base_url, "models", api_key, None, REQUEST_TIMEOUT_SECONDS)
    except ProbeError as error:
        diag.log_event(
            "WARNING", "backend", "检测可用模型失败", logger="backend.model_probe",
            status=error.status, detail=str(error), elapsed_ms=timer.elapsed_ms(),
        )
        return {"ok": False, "message": str(error), "endpoint": "",
                "models": [], "elapsed_ms": timer.elapsed_ms(), "http_status": error.status}

    models = _extract_ids(payload)
    elapsed = timer.elapsed_ms()
    diag.log_event(
        "INFO", "backend", "检测可用模型完成", logger="backend.model_probe",
        endpoint=endpoint, model_count=len(models), elapsed_ms=elapsed,
    )
    if not models:
        # 上游认了这个密钥（HTTP 200），只是清单是空的，典型响应就是
        # {"data": [], "object": "list"}。这不是地址填错，而是这个密钥所在的
        # 分组一个模型都没授权——同一个 Base URL 换个密钥往往就能拿到几十个。
        # 原来只说「没有返回任何模型」，用户会一直去改地址，方向就错了。
        return {"ok": False,
                "message": f"{endpoint} 通了，但这个密钥拿到的清单是空的。"
                           "地址没问题，多半是该密钥所属的分组没有授权任何模型——"
                           "换个密钥试试，或直接在下面手动填模型名。",
                "endpoint": endpoint,
                "models": [], "elapsed_ms": elapsed, "http_status": 0}
    return {"ok": True, "message": f"上游提供 {len(models)} 个模型", "endpoint": endpoint,
            "models": models, "elapsed_ms": elapsed, "http_status": 0}


def test_model(base_url: str, api_key: str, model: str) -> dict:
    """真发一次极短的对话请求，确认这个模型名能调通。

    清单里有、实际调不动（没权限、已下架、名字要带前缀）的情况很常见，
    所以「在清单里」和「能用」得分开验。
    """
    timer = diag.Timer()
    model = (model or "").strip()
    if not model:
        return {"ok": False, "message": "没有选择模型", "elapsed_ms": 0,
                "reply": "", "http_status": 0}

    body = {
        "model": model,
        "messages": [{"role": "user", "content": TEST_PROMPT}],
        "max_tokens": TEST_MAX_TOKENS,
        "stream": False,
    }
    diag.log_event(
        "INFO", "backend", "开始测试模型", logger="backend.model_probe",
        base_url=base_url, model=model, api_key=diag.mask_secret(api_key),
    )
    try:
        # 走兼容层：GPT-5 / o 系列只认 max_completion_tokens，直接发 max_tokens
        # 会被 400 顶回来。测试按钮要是照着原样报错，用户看到的就是「这个模型不
        # 可用」——而它其实是能用的，只是参数名要换。
        # _fetch 是位置参数，这里用关键字展开把请求体重新收回成 dict。
        payload, _ = model_params.request_with_healing(
            lambda **sent: _fetch(
                base_url, "chat/completions", api_key, sent, TEST_TIMEOUT_SECONDS
            ),
            base_url,
            model,
            body,
        )
    except ProbeError as error:
        diag.log_event(
            "WARNING", "backend", "模型测试失败", logger="backend.model_probe",
            model=model, status=error.status, elapsed_ms=timer.elapsed_ms(),
        )
        return {"ok": False, "message": str(error), "elapsed_ms": timer.elapsed_ms(),
                "reply": "", "http_status": error.status}

    elapsed = timer.elapsed_ms()
    # 有的中转站用 200 包一个 error 体回来，不看这一层会误判成可用。
    error_body = payload.get("error") if isinstance(payload, dict) else None
    if error_body:
        message = str((error_body or {}).get("message") or error_body)
        return {"ok": False, "message": f"上游返回错误：{message}", "elapsed_ms": elapsed,
                "reply": "", "http_status": 0}

    choices = (payload or {}).get("choices") or []
    message_obj = (choices[0] or {}).get("message") or {} if choices else {}
    reply = str(message_obj.get("content") or "").strip()
    usage = (payload or {}).get("usage") or {}
    diag.log_event(
        "INFO", "backend", "模型测试完成", logger="backend.model_probe",
        model=model, reply_chars=len(reply), elapsed_ms=elapsed,
    )
    if not choices:
        return {"ok": False, "message": "上游没有返回回答内容", "elapsed_ms": elapsed,
                "reply": "", "http_status": 0}
    return {
        "ok": True,
        # 只回了空字符串也算通：思考型模型可能把预算全用在思考上，
        # 但请求本身确实被正常受理了。
        "message": f"可用，用时 {elapsed / 1000:.1f}s"
                   + (f"，输出 {usage.get('completion_tokens')} tokens"
                      if usage.get("completion_tokens") is not None else ""),
        "elapsed_ms": elapsed,
        "reply": reply[:200],
        "http_status": 0,
    }
