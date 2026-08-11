"""聊天附件上传接口。"""
from fastapi import APIRouter, File, HTTPException, UploadFile

import database as db
import files as file_service


router = APIRouter(prefix="/api", tags=["uploads"])
# 设置里没有有效值时的兜底上限，同时也是允许配置的最大值。
HARD_LIMIT_MB = 100


def _limit_mb(settings: dict, key: str, default: int) -> int:
    try:
        value = int(settings.get(key, default))
    except (TypeError, ValueError):
        value = default
    return min(max(value, 1), HARD_LIMIT_MB)


@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    settings = db.get_settings()
    single_max_mb = _limit_mb(settings, "single_file_max_mb", 20)
    data = await file.read()
    if len(data) > single_max_mb * 1024 * 1024:
        raise HTTPException(413, f"文件超过 {single_max_mb}MB 限制，可在设置中调整")
    return file_service.save_upload(file.filename or "未命名文件", data)

