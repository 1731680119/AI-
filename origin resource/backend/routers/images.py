"""图片生成、编辑、历史记录和文件读取接口。"""
import asyncio
import json
import os
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

import database as db
import image_export
import images as image_service


router = APIRouter(prefix="/api/images", tags=["images"])
MAX_IMAGE_BYTES = 30 * 1024 * 1024
MAX_REFERENCE_IMAGES = 4


def _parse_reference_notes(raw: str, count: int) -> list[str]:
    """前端以 JSON 数组传入每张参考图的特征说明，长度与参考图对齐。"""
    notes: list[str] = []
    raw = (raw or "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, list):
            notes = [str(item or "").strip() for item in parsed]
    if len(notes) < count:
        notes += [""] * (count - len(notes))
    return notes[:count]


class GenerateBody(BaseModel):
    prompt: str
    negative_prompt: str = ""
    model: str | None = None
    size: str | None = None
    quality: str | None = None
    n: int = 1
    # 用户在图片页选中的多 API 渠道。后端不读它——渠道是桌面层在请求发出前
    # 临时写进 image_base_url / image_api_key 的。声明出来只是为了让这个字段
    # 在接口文档里可见，也免得以后有人把它当成脏数据删掉。
    api_id: str | None = None


def _require_image_channel(settings: dict) -> None:
    """没有可用渠道就直接回 400，别让请求走到上游再拿一个看不懂的报错。

    1.2.19 起 image_api_key 由桌面层在发请求前临时写进来（用户在图片页的模型
    选择器里选的那条多 API 渠道）。所以它为空只有两种可能：跑在浏览器里没有
    桌面桥，或者一条渠道都没标出 image 用途的模型。两种都指向同一件事——
    去多 API 里配一条能画图的渠道。
    """
    if settings.get("image_api_key"):
        return
    raise HTTPException(
        400,
        "没有可用的图片渠道：请在设置的「多 API」里添加渠道，"
        "并在它的模型清单里把绘画模型的用途标成「图片」。",
    )


@router.get("")
def list_images():
    return db.list_images()


@router.post("/generate")
def generate_images(body: GenerateBody):
    settings = db.get_settings()
    _require_image_channel(settings)
    model = body.model or settings["image_model"]
    size = body.size or settings["image_size"]
    quality = body.quality or settings["image_quality"]
    count = max(1, min(body.n, 4))
    try:
        filenames = image_service.generate_images(
            settings, body.prompt, body.negative_prompt, model, size, quality, count
        )
    except Exception as error:
        raise HTTPException(500, f"图片生成失败：{error}") from error
    return db.add_image_record(
        "generate", body.prompt, body.negative_prompt, model, size, quality, filenames
    )


@router.post("/edit")
async def edit_image(
    file: UploadFile = File(...),
    references: list[UploadFile] = File(default=[]),
    prompt: str = Form(...),
    negative_prompt: str = Form(""),
    reference_notes: str = Form(""),
    model: str = Form(""),
    size: str = Form(""),
    quality: str = Form(""),
    # 同 GenerateBody.api_id：桌面层用，后端不读。不声明的话 FastAPI 会把这个
    # 多出来的表单字段直接丢掉，虽然不报错，但接口文档里就看不到它了。
    api_id: str = Form(""),
):
    settings = db.get_settings()
    _require_image_channel(settings)
    model = model or settings["image_model"]
    # 编辑不套用设置里的图片尺寸：size 为空即「跟随原图」，由前端显式指定才固定尺寸。
    quality = quality or settings["image_quality"]
    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "主图超过 30MB 限制")

    ref_uploads = [item for item in (references or []) if item and item.filename]
    if len(ref_uploads) > MAX_REFERENCE_IMAGES:
        raise HTTPException(400, f"参考图最多 {MAX_REFERENCE_IMAGES} 张")

    reference_payload: list[tuple[bytes, str]] = []
    reference_names: list[str] = []
    for index, upload in enumerate(ref_uploads, start=1):
        ref_data = await upload.read()
        if len(ref_data) > MAX_IMAGE_BYTES:
            raise HTTPException(413, f"第 {index} 张参考图超过 30MB 限制")
        name = upload.filename or f"reference_{index}.png"
        reference_payload.append((ref_data, name))
        reference_names.append(name)

    notes = _parse_reference_notes(reference_notes, len(reference_payload))

    try:
        # 必须扔到线程里跑。这个函数会同步等上游画完图（几十秒到两分钟），而本
        # 处理函数是 async def——直接调就等于把 uvicorn 的事件循环占死，那段时间
        # 里**所有**请求都派发不出去，表现是「编辑图片时删不掉聊天/图片记录，
        # 点了完全没反应」，而且后端日志里那条被堵住的请求 elapsed_ms 还很小
        #（计时从请求到达处理函数才开始，看不出它在队列里等了多久）。
        # 同一个坑在 routers/uploads.py 的 save_upload 上也有，一起改的。
        result = await asyncio.to_thread(
            image_service.edit_image_with_references,
            settings,
            data,
            file.filename or "image.png",
            reference_payload,
            prompt,
            negative_prompt,
            model,
            size,
            quality,
            reference_notes=notes,
        )
    except Exception as error:
        raise HTTPException(500, f"图片编辑失败：{error}") from error
    return db.add_image_record(
        "edit",
        prompt,
        negative_prompt,
        model,
        size or "跟随原图",
        quality,
        result["files"],
        source_image_name=file.filename or "",
        reference_names=reference_names,
        reference_notes=notes,
    )


@router.delete("/{record_id}")
def delete_image(record_id: str):
    filenames = db.delete_image_record(record_id)
    image_service.delete_files(filenames)
    return {"ok": True}


class ExportBody(BaseModel):
    """导出参数。除 name / format 外都有默认值，前端只传用户真正调过的项。"""

    name: str
    format: str
    quality: int = 92
    tiff_compression: str = "lzw"
    dpi: int = image_export.DEFAULT_DPI
    background: str = "#FFFFFF"
    width: int | None = None
    height: int | None = None


@router.get("/export/formats")
def list_export_formats():
    """当前环境真正能编码出来的格式。前端拿它渲染下拉，不写死清单。"""
    return {"formats": list(image_export.available_formats())}


@router.post("/export")
def export_image(body: ExportBody):
    safe_name = os.path.basename(body.name)
    source = os.path.join(image_service.IMAGES_DIR, safe_name)
    try:
        data, filename, mime = image_export.convert(
            source,
            body.format,
            quality=body.quality,
            tiff_compression=body.tiff_compression,
            dpi=body.dpi,
            background=body.background,
            width=body.width,
            height=body.height,
        )
    except image_export.ExportError as error:
        raise HTTPException(400, str(error)) from error
    except Exception as error:  # noqa: BLE001 - 兜底，别把 Pillow 的原始异常抛成 500 堆栈
        raise HTTPException(500, f"图片导出失败：{error}") from error
    # 文件名可能含中文，filename* 用 RFC 5987 编码，filename 留一份 ASCII 兜底。
    disposition = f"attachment; filename=\"export.{filename.rsplit('.', 1)[-1]}\"; filename*=UTF-8''{quote(filename)}"
    return Response(content=data, media_type=mime, headers={"Content-Disposition": disposition})


@router.get("/file/{name}")
def get_image_file(name: str):
    safe_name = os.path.basename(name)
    path = os.path.join(image_service.IMAGES_DIR, safe_name)
    if not os.path.exists(path):
        raise HTTPException(404, "图片不存在")
    return FileResponse(path)

