"""应用设置接口。"""
import asyncio

from fastapi import APIRouter
from pydantic import BaseModel

import database as db
import logging_config as diag
import model_params
import model_probe
import web_search


router = APIRouter(prefix="/api/settings", tags=["settings"])

#: 存在 settings 表里、但**不能出现在这个接口的返回值**里的键。
#:
#: 前端保存设置的写法一律是 `saveSettings({ ...settings, 改动的那项 })`——把
#: GET 拿到的整份原样 PUT 回来。而 SettingsPatch 是 extra="forbid"，所以只要
#: 返回值里混进一个它没声明的键，下一次保存就会 422，表现是「选模型、拖模型
#: 顺序、保存设置」统统失败。
#:
#: `model_param_quirks` 正是这样一个键：它由 model_params 自己读写（走
#: db.get_settings()，不经过这里），是后端内部的记账，前端既用不上也不该回写
#: ——回写等于让一份旧副本盖掉刚学到的修正。所以在接口边界剔掉，而不是给
#: SettingsPatch 补一个字段。往 settings 表里加新的内部键时，记得也加到这里。
_INTERNAL_KEYS = frozenset({model_params.SETTINGS_KEY})


def _public(settings: dict) -> dict:
    """剔掉内部键后的设置，用于所有会回到前端的返回值。"""
    return {key: value for key, value in settings.items() if key not in _INTERNAL_KEYS}


class SettingsPatch(BaseModel):
    """所有字段均可选，因此前端可以只更新发生变化的设置。"""

    base_url: str | None = None
    api_key: str | None = None
    models: list[str] | None = None
    default_model: str | None = None
    system_prompt: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    default_thinking: str | None = None
    theme: str | None = None
    # 图片生成：1.2.19 起渠道并进桌面端的「多 API」，image_providers 已删除。
    # 下面三个字段仍然接受写入，但只由桌面层在发图片请求前后临时改写
    # （和聊天的 base_url / api_key 同一套握手），设置界面里只剩尺寸和质量。
    image_base_url: str | None = None
    image_api_key: str | None = None
    image_model: str | None = None
    image_size: str | None = None
    image_quality: str | None = None
    # 上下文自动压缩
    context_auto_compact: bool | None = None
    context_max_chars: int | None = None
    context_compact_trigger_percent: int | None = None
    context_keep_recent_chars: int | None = None
    # 附件大小限制
    single_file_max_mb: int | None = None
    single_file_max_chars: int | None = None
    message_files_max_mb: int | None = None
    message_files_max_chars: int | None = None
    # 工具调用与联网搜索
    tools_enabled: bool | None = None
    search_providers: list[dict] | None = None
    search_provider_id: str | None = None
    # 回答风格
    styles: list[dict] | None = None
    default_style_id: str | None = None
    # 长期记忆
    memory_enabled: bool | None = None
    memory_auto_capture: bool | None = None
    memory_max_items: int | None = None
    memory_max_chars: int | None = None
    # 提示词模板
    prompt_templates: list[dict] | None = None
    # 代码执行
    code_exec_enabled: bool | None = None
    # 诊断
    verbose_logging: bool | None = None

    model_config = {"extra": "forbid"}


@router.get("")
def get_settings():
    return _public(db.get_settings())


@router.put("")
def put_settings(patch: SettingsPatch):
    data = {key: value for key, value in patch.model_dump().items() if value is not None}
    result = db.save_settings(data)
    if "verbose_logging" in data:
        diag.set_verbose(bool(data["verbose_logging"]))
    # 只记录改了哪些字段，不记录字段值本身，避免密钥与提示词入库外泄。
    diag.log_event(
        "INFO", "backend", "设置已更新",
        logger="backend.settings", changed=sorted(data.keys()),
    )
    return _public(result)


class SearchProviderTest(BaseModel):
    """检测用的一条搜索配置。

    直接收字段而不是收配置 id，是为了让用户在设置页改完、还没点保存时就能测。
    """

    name: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    max_output_tokens: int | None = None

    model_config = {"extra": "ignore"}


@router.post("/search-test")
async def test_search_provider(provider: SearchProviderTest):
    """用给定配置真跑一次联网搜索，回一份检测报告。

    真跑而不是只探活：中转站能连通、密钥也对，但不支持服务端内置 web_search
    的情况很常见，只有看它到底有没有交出来源链接才能判断。
    """
    payload = provider.model_dump()
    diag.log_event(
        "INFO", "backend", "开始检测联网搜索配置",
        logger="backend.settings", base_url=payload.get("base_url"),
        model=payload.get("model"), api_key=diag.mask_secret(payload.get("api_key")),
    )
    # 检测是同步阻塞的网络请求，扔到线程里跑，别把事件循环卡住。
    result = await asyncio.to_thread(web_search.test_provider, payload)
    diag.log_event(
        "INFO", "backend", "联网搜索配置检测完成",
        logger="backend.settings", status=result.get("status"),
        source_count=len(result.get("sources") or []), elapsed_ms=result.get("elapsed_ms"),
    )
    return result


class ModelProbeRequest(BaseModel):
    """检测可用模型用的一组凭据。

    同样收字段而不是读设置：聊天、图片、搜索三处各有各的地址和密钥，
    而且用户常常是刚粘上地址、还没保存就想看看有哪些模型能用。
    """

    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None

    model_config = {"extra": "ignore"}


@router.post("/model-list")
async def list_remote_models(request: ModelProbeRequest):
    """问上游要一份模型清单，供设置页勾选。只读清单，不产生调用费用。"""
    return await asyncio.to_thread(
        model_probe.list_models, request.base_url or "", request.api_key or "",
    )


@router.post("/model-test")
async def test_remote_model(request: ModelProbeRequest):
    """真发一次极短的对话请求，确认某个模型确实调得动。

    清单里列着却调不动（没权限、已下架、名字要带前缀）很常见，
    所以「在清单里」和「能用」分成两个接口。
    """
    return await asyncio.to_thread(
        model_probe.test_model,
        request.base_url or "", request.api_key or "", request.model or "",
    )
