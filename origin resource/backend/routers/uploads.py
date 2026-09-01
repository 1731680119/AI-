"""聊天附件上传接口。"""
import asyncio

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
    # save_upload 内联做 PDF/docx/xlsx/pptx 解析，大文件能跑好几秒，是同步阻塞的。
    # 本处理函数是 async def，直接调会占死事件循环，那段时间所有请求都派发不出去
    #（和 routers/images.py 的 /edit 是同一个坑，表现是传大附件时界面整体卡住）。
    return await asyncio.to_thread(
        file_service.save_upload, file.filename or "未命名文件", data,
    )

