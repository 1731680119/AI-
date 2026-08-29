"""模型参数兼容层：同一套 OpenAI 兼容接口，各家上游认的参数并不一样。

已经踩到的两种：

- GPT-5 / o 系列要 `max_completion_tokens`，发 `max_tokens` 直接 400
  （`unsupported_parameter`）；
- 有的中转站不接受 `reasoning_effort` 和 `tools` 同时出现，要求改走
  `/v1/responses` 或把档位设成 none。

这里做两层：

1. **内置规则打底** —— 已知的模型族在发请求前就把参数改对，不浪费一次往返；
2. **400 自愈** —— 上游报「不支持某参数」时，按它自己给出的提示改一次再发，
   成功后把结论记下来，之后同一个上游 + 同一个模型直接用修正后的参数。

记账的键是「上游地址 + 模型名」而不是渠道 id：后端只看得到当前生效的
base_url，而且同一个模型在不同中转站的脾气确实不同（ai-wave 卡
`max_tokens`，vveai 卡 `reasoning_effort`），地址正好是区分它们的天然键。
两个渠道填了同一个地址同一把密钥时它们本来就是同一个上游，共用结论是对的。
"""
import re
import time
from typing import Any
from typing import Callable

import database as db
import logging_config as diag


#: 学到的修正存在 settings 表的这个键下面，结构见 `remember`。
#:
#: 它是后端内部记账，**不能出现在 `/api/settings` 的返回值里**：前端保存设置
#: 用的是「把 GET 到的整份原样 PUT 回来」，而 SettingsPatch 是 extra="forbid"，
#: 混进一个它没声明的键就会 422。剔除逻辑在 `routers/settings.py` 的
#: `_INTERNAL_KEYS`，改这个键名时那边要跟着改。
SETTINGS_KEY = "model_param_quirks"

#: 允许自动去掉的参数。`model` / `messages` / `stream` / `tools` 是请求的骨架，
#: 去掉它们等于换了一件事去做（尤其 tools，静默去掉会让工具调用无声失效），
#: 那种情况宁可把上游的原话如实报给用户。
_DROPPABLE = frozenset({
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "reasoning_effort",
    "tool_choice",
    "stream_options",
    "logprobs",
    "seed",
    "stop",
    "n",
})

#: 记账上限。超了按学到的时间丢最旧的，避免用户换过很多渠道后无限膨胀。
_MAX_ENTRIES = 200

#: gpt-5 系列和 o 系列：这两族是 `max_completion_tokens` 的正主，
#: 而且只接受默认的 temperature。
_REASONING_FAMILY = re.compile(r"^(?:gpt-?5|o[1-9](?:-|$))")

#: 「Use 'xxx' instead」这类改名提示。
_HINT_REPLACEMENT = re.compile(
    r"use\s+['\"`]?([A-Za-z_][A-Za-z0-9_]*)['\"`]?\s+instead", re.I
)
#: 「set reasoning_effort to 'none'」这类赋值提示。有的上游不发这个参数时
#: 默认照样开推理，光去掉没用，必须按它点名的值显式发过去（ai-wave 的
#: gpt-5.6 就是这样，见 08 §1.2.21 ⑦）。所以这条要在「去掉」之前先试。
_HINT_SET_VALUE = re.compile(
    r"set(?:ting)?\s+['\"`]?([A-Za-z_][A-Za-z0-9_]*)['\"`]?\s+to\s+"
    r"['\"`]?([A-Za-z0-9_.-]+)['\"`]?",
    re.I,
)
#: 上游没给结构化 param 字段时，从话里把参数名抠出来。
_HINT_PARAM = re.compile(
    r"(?:unsupported|unrecognized|unknown|invalid|not\s+supported)"
    r"[^'\"]{0,60}['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]",
    re.I,
)
#: openai 客户端的 str(e) 是 `Error code: 400 - {...}`；model_probe 的
#: ProbeError 里是 `→ HTTP 400 {...}`。两种都认。
_STATUS = re.compile(r"(?:Error code|HTTP)[:\s]+(\d{3})")

_HEALABLE_STATUS = (400, 422)

_store: dict[str, dict] | None = None


# ---------------------------------------------------------------- 键与内置规则

def _bare_model(model: str) -> str:
    """去掉 `openai/gpt-5` 这类厂商前缀，只留模型名本身。"""
    name = (model or "").strip().lower()
    if "/" in name:
        name = name.rsplit("/", 1)[-1]
    return name


def _channel(base_url: str) -> str:
    """把地址归一成记账用的短键：去协议、去末尾斜杠、小写。"""
    text = (base_url or "").strip().lower().rstrip("/")
    return re.sub(r"^https?://", "", text) or "(默认)"


def quirk_key(base_url: str, model: str) -> str:
    return f"{_channel(base_url)}||{_bare_model(model)}"


def _builtin(model: str) -> dict:
    """内置规则给出的修正。空字典表示这个模型没有已知的特殊要求。"""
    if _REASONING_FAMILY.match(_bare_model(model)):
        return {
            "rename": {"max_tokens": "max_completion_tokens"},
            # 这两族只接受默认档位；等于 1 时留着，其它值发过去会被 400 顶回来。
            "drop_unless_default": {"temperature": 1},
        }
    return {}


# ---------------------------------------------------------------- 修正的读写

def _get_store() -> dict[str, dict]:
    global _store
    if _store is None:
        try:
            saved = db.get_settings().get(SETTINGS_KEY)
            _store = dict(saved) if isinstance(saved, dict) else {}
        except Exception as error:  # 读不到就当没学过，别拦住这次请求
            diag.log_event(
                "WARNING", "backend", f"读取模型参数修正记录失败：{error}",
                logger="backend.model_params",
            )
            _store = {}
    return _store


def learned(base_url: str, model: str) -> dict:
    return dict(_get_store().get(quirk_key(base_url, model)) or {})


def merge_fix(base: dict, extra: dict) -> dict:
    """把两份修正叠起来。后者优先，`drop` 取并集。"""
    out = {
        "rename": {**(base.get("rename") or {}), **(extra.get("rename") or {})},
        "drop": sorted(set(base.get("drop") or []) | set(extra.get("drop") or [])),
        "set": {**(base.get("set") or {}), **(extra.get("set") or {})},
        "drop_unless_default": {
            **(base.get("drop_unless_default") or {}),
            **(extra.get("drop_unless_default") or {}),
        },
    }
    return {key: value for key, value in out.items() if value}


def remember(base_url: str, model: str, fix: dict) -> None:
    """记住某个上游 + 模型要怎么改参数。写失败不影响本次对话。"""
    if not fix:
        return
    store = _get_store()
    key = quirk_key(base_url, model)
    entry = merge_fix(store.get(key) or {}, fix)
    entry["learned_at"] = int(time.time())
    store[key] = entry

    if len(store) > _MAX_ENTRIES:
        oldest = sorted(store.items(), key=lambda kv: kv[1].get("learned_at") or 0)
        for stale_key, _ in oldest[: len(store) - _MAX_ENTRIES]:
            store.pop(stale_key, None)

    try:
        db.save_settings({SETTINGS_KEY: store})
    except Exception as error:
        diag.log_event(
            "WARNING", "backend", f"保存模型参数修正记录失败：{error}",
            logger="backend.model_params", quirk_key=key,
        )


def forget(base_url: str | None = None, model: str | None = None) -> int:
    """清掉学到的修正。都不传就是全清。返回删掉几条。"""
    store = _get_store()
    if base_url is None and model is None:
        count = len(store)
        store.clear()
    elif model is not None and base_url is not None:
        count = 1 if store.pop(quirk_key(base_url, model), None) else 0
    else:
        prefix = f"{_channel(base_url or '')}||"
        doomed = [key for key in store if key.startswith(prefix)]
        for key in doomed:
            store.pop(key, None)
        count = len(doomed)
    if count:
        try:
            db.save_settings({SETTINGS_KEY: store})
        except Exception as error:
            diag.log_event(
                "WARNING", "backend", f"清除模型参数修正记录失败：{error}",
                logger="backend.model_params",
            )
    return count


# ---------------------------------------------------------------- 应用与诊断

def apply_fix(kwargs: dict, fix: dict) -> dict:
    """按一份修正改写请求参数。不改动传进来的字典。"""
    out = dict(kwargs)
    for old, new in (fix.get("rename") or {}).items():
        if old in out:
            value = out.pop(old)
            if new:
                out[new] = value
    for name in fix.get("drop") or []:
        out.pop(name, None)
    for name, value in (fix.get("set") or {}).items():
        if name in out:
            out[name] = value
    for name, default in (fix.get("drop_unless_default") or {}).items():
        if name not in out:
            continue
        try:
            same = float(out[name]) == float(default)
        except (TypeError, ValueError):
            same = out[name] == default
        if not same:
            out.pop(name, None)
    return out


def prepare(base_url: str, model: str, kwargs: dict) -> dict:
    """发请求前先过一遍内置规则和学到的修正。"""
    fix = merge_fix(_builtin(model), learned(base_url, model))
    if not fix:
        return dict(kwargs)
    prepared = apply_fix(kwargs, fix)
    if prepared != kwargs:
        diag.log_event(
            "DEBUG", "backend", "按兼容规则调整了请求参数",
            logger="backend.model_params",
            model=model, base_url=base_url or "(默认)", fix=_describe(fix),
        )
    return prepared


def _error_parts(error: Exception) -> tuple[int, str, str | None]:
    """从异常里取出 (状态码, 提示原文, 上游标注的参数名)。

    `error.body` 有两种形状，**必须都认**：

    - `{"error": {"message": ..., "param": ...}}`：原始响应体的样子；
    - `{"message": ..., "param": ...}`：openai SDK 会**先拆掉外面那层 `error`**
      再塞进异常里，实际拿到的多半是这一种。

    只认前一种的话 `param` 永远取不到，整个 400 自愈层就等于没有——
    从来不重试，直接把上游的原话抛给用户。（gpt-5.6-luna 那条
    「Function tools with reasoning_effort are not supported」就是这么漏掉的，
    见 08 §1.2.21 ⑦。）回退的正则也救不了：它要求参数名的引号出现在
    「not supported」后 60 个字符内，那条消息隔了一百多个字符。
    """
    text = str(error)
    status = getattr(error, "status_code", None) or getattr(error, "status", None)
    if not isinstance(status, int) or not status:
        found = _STATUS.search(text)
        status = int(found.group(1)) if found else 0

    message = text
    param: str | None = None
    body = getattr(error, "body", None)
    detail = None
    if isinstance(body, dict):
        inner = body.get("error")
        # 拆过一层的那种自己就是 detail；两种形状都落在这一句里。
        detail = inner if isinstance(inner, dict) else body
    if isinstance(detail, dict):
        message = str(detail.get("message") or text)
        raw_param = detail.get("param")
        if isinstance(raw_param, str) and raw_param.strip():
            param = raw_param.strip()
    return status, message, param


def diagnose(error: Exception, kwargs: dict) -> dict:
    """看上游的 400 是不是在嫌某个参数；能修就返回修正，不能修返回空。"""
    status, message, param = _error_parts(error)
    if status not in _HEALABLE_STATUS:
        return {}

    if not param:
        found = _HINT_PARAM.search(message)
        param = found.group(1) if found else None
    if not param or param not in kwargs:
        return {}

    # 先看有没有「set xxx to 'yyy'」：有的上游不发这个参数时默认照样开推理，
    # 光去掉没用（重试还是同一个 400），必须按它点名的值显式发过去。
    # 只对 _DROPPABLE 里的参数生效：model 之类的骨架参数被上游「建议改值」
    # 时照样如实报错，静默换模型比报错糟糕得多。
    assign = _HINT_SET_VALUE.search(message)
    if assign and assign.group(1) == param and param in _DROPPABLE:
        value = assign.group(2)
        if str(kwargs.get(param)) != value:
            return {"set": {param: value}}

    hint = _HINT_REPLACEMENT.search(message)
    replacement = hint.group(1) if hint else None
    if replacement and replacement != param and replacement not in kwargs:
        return {"rename": {param: replacement}}

    if param in _DROPPABLE:
        return {"drop": [param]}
    # 骨架参数（tools、messages 之类）不动：静默改掉等于悄悄换了功能。
    return {}


def _describe(fix: dict) -> str:
    parts = [f"{old} → {new}" for old, new in (fix.get("rename") or {}).items()]
    parts += [f"去掉 {name}" for name in fix.get("drop") or []]
    parts += [f"{name} 设为 {value}" for name, value in (fix.get("set") or {}).items()]
    parts += [
        f"非默认值时去掉 {name}" for name in fix.get("drop_unless_default") or {}
    ]
    return "；".join(parts) or "(无)"


def request_with_healing(
    create: Callable[..., Any],
    base_url: str,
    model: str,
    kwargs: dict,
    max_retries: int = 2,
) -> Any:
    """执行 `create(**kwargs)`，遇到参数类 400 就按上游的提示改一次再发。

    最多重试 `max_retries` 次（同一次请求可能连着被嫌两个参数）。全都修不好
    就把最后一次的异常原样抛出去——那才是用户该看到的真实原因。
    """
    attempt_kwargs = prepare(base_url, model, kwargs)
    learned_fix: dict = {}
    for remaining in range(max_retries, -1, -1):
        try:
            result = create(**attempt_kwargs)
        except Exception as error:
            fix = diagnose(error, attempt_kwargs) if remaining else {}
            if not fix:
                raise
            attempt_kwargs = apply_fix(attempt_kwargs, fix)
            learned_fix = merge_fix(learned_fix, fix)
            diag.log_event(
                "WARNING", "backend",
                f"上游不接受这个参数，已自动改正重试：{_describe(fix)}",
                logger="backend.model_params",
                model=model, base_url=base_url or "(默认)",
                upstream_message=str(error)[:300],
            )
            continue
        if learned_fix:
            remember(base_url, model, learned_fix)
            diag.log_event(
                "INFO", "backend", f"记住了这个上游对该模型的参数要求：{_describe(learned_fix)}",
                logger="backend.model_params",
                model=model, base_url=base_url or "(默认)",
            )
        return result
