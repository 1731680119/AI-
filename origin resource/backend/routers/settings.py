"""应用设置接口。"""
import asyncio

from fastapi import APIRouter
from pydantic import BaseModel

import database as db
import logging_config as diag
import model_probe
import web_search


router = APIRouter(prefix="/api/settings", tags=["settings"])


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
    return db.get_settings()


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
    return result


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
