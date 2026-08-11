"""应用设置接口。"""
from fastapi import APIRouter
from pydantic import BaseModel

import database as db
import logging_config as diag


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
    search_base_url: str | None = None
    search_api_key: str | None = None
    search_model: str | None = None
    search_max_output_tokens: int | None = None
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
