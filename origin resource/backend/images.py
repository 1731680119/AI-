"""图片生成 / 编辑：调用 OpenAI 兼容 images API，文件存储在 data/images/"""
import base64
import io
import os
import urllib.request
import uuid
from datetime import datetime

from openai import OpenAI

import logging_config as diag
from paths import IMAGES_DIR as APP_IMAGES_DIR


IMAGES_DIR = str(APP_IMAGES_DIR)


def _ensure_dir():
    os.makedirs(IMAGES_DIR, exist_ok=True)


def get_client(settings: dict) -> OpenAI:
    kwargs = {"api_key": settings["image_api_key"]}
    if settings.get("image_base_url"):
        kwargs["base_url"] = settings["image_base_url"]
    return OpenAI(**kwargs)


def build_final_prompt(prompt: str, negative_prompt: str = "") -> str:
    prompt = prompt.strip()
    negative_prompt = negative_prompt.strip()
    if not negative_prompt:
        return prompt
    return (
        f"{prompt}\n\n"
        f"额外要求：请尽量避免以下内容：\n{negative_prompt}\n\n"
        f"如果其中部分要求与主提示冲突，请优先满足主提示，同时尽量避免上述不希望出现的元素。"
    )


def _negative_block(negative_prompt: str) -> str:
    negative_prompt = negative_prompt.strip()
    if not negative_prompt:
        return ""
    return (
        f"\n\n额外要求：请尽量避免以下内容：\n{negative_prompt}\n\n"
        f"如果其中部分要求与主提示冲突，请优先满足主提示，同时尽量避免上述不希望出现的元素。"
    )


def build_reference_prompt(
    prompt: str,
    negative_prompt: str,
    reference_notes: list[str],
    inline_references: bool,
) -> str:
    """拼装「主图 + 参考图」提示词。

    inline_references=True：图片本体会随请求一起上传，提示词只需说明每张图的角色。
    inline_references=False：接口只收单图，参考特征只能靠文字描述转达。
    """
    prompt = prompt.strip()
    total = len(reference_notes)
    lines: list[str] = []

    if inline_references:
        lines.append(
            f"本次共提供 {total + 1} 张图片。第 1 张是主图，是唯一需要被修改并输出的图片；"
            f"第 2 至第 {total + 1} 张是参考图，只用于提取特征，不要把它们的画面内容整体搬到结果里，"
            f"也不要把它们拼接进输出。"
        )
        lines.append("请保持主图的整体构图、主体身份和画面比例，只按下面的要求做局部修改。")
        lines.append("各参考图需要参考的特征：")
        for index, note in enumerate(reference_notes, start=2):
            note = (note or "").strip()
            detail = note if note else "由你判断其最显著的风格特征（如配色、光影、材质、质感）"
            lines.append(f"- 第 {index} 张参考图：{detail}")
    else:
        lines.append(
            "请修改我提供的这张主图，保持它的整体构图、主体身份和画面比例，只做下面描述的局部修改。"
        )
        lines.append(
            f"我另有 {total} 张参考图无法一并上传，其需要参考的特征描述如下，请据此进行修改："
        )
        for index, note in enumerate(reference_notes, start=1):
            note = (note or "").strip()
            detail = note if note else "（未填写具体特征，请忽略这一条）"
            lines.append(f"- 参考图 {index}：{detail}")

    lines.append("")
    lines.append(f"修改要求：{prompt}")

    return "\n".join(lines) + _negative_block(negative_prompt)


def _item_to_bytes(item) -> bytes:
    if getattr(item, "b64_json", None):
        return base64.b64decode(item.b64_json)
    if getattr(item, "url", None):
        with urllib.request.urlopen(item.url) as resp:
            return resp.read()
    raise ValueError("接口未返回可用的图片数据（既没有 b64_json，也没有 url）")


def save_image_bytes(data: bytes, prefix: str = "generated") -> str:
    """保存图片，返回文件名"""
    _ensure_dir()
    fid = str(uuid.uuid4())[:8]
    filename = f"{prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{fid}.png"
    with open(os.path.join(IMAGES_DIR, filename), "wb") as f:
        f.write(data)
    return filename


def generate_images(
    settings: dict,
    prompt: str,
    negative_prompt: str,
    model: str,
    size: str,
    quality: str,
    n: int,
) -> list[str]:
    """文生图，返回保存的文件名列表"""
    client = get_client(settings)
    final_prompt = build_final_prompt(prompt, negative_prompt)
    timer = diag.Timer()
    meta = {"model": model, "size": size, "quality": quality, "n": n,
            "prompt_chars": len(final_prompt)}
    preview = diag.verbose_preview(final_prompt, limit=600)
    if preview:
        meta["prompt_preview"] = preview
    diag.log_event("INFO", "backend", "开始文生图", logger="backend.images", **meta)
    try:
        response = client.images.generate(
            model=model, prompt=final_prompt, size=size, quality=quality, n=n
        )
    except Exception as error:
        diag.log_exception(
            "backend.images", "文生图失败", error, elapsed_ms=timer.elapsed_ms(), **meta
        )
        raise
    files = [save_image_bytes(_item_to_bytes(item), "generated") for item in response.data]
    diag.log_event(
        "INFO", "backend", "文生图完成", logger="backend.images",
        model=model, saved=len(files), elapsed_ms=timer.elapsed_ms(),
    )
    return files


def edit_image(
    settings: dict,
    image_bytes: bytes,
    image_name: str,
    prompt: str,
    negative_prompt: str,
    model: str,
    size: str,
    quality: str,
) -> list[str]:
    """垫图编辑，返回保存的文件名列表"""
    client = get_client(settings)
    final_prompt = build_final_prompt(prompt, negative_prompt)
    buf = io.BytesIO(image_bytes)
    buf.name = image_name or "image.png"
    response = client.images.edit(
        model=model, image=buf, prompt=final_prompt, quality=quality, **_size_kwargs(size)
    )
    return [save_image_bytes(_item_to_bytes(item), "edited") for item in response.data]


def _size_kwargs(size: str) -> dict:
    """size 为空表示「跟随原图」：传 size="auto" 让接口按原图尺寸输出。

    注意不能传 size=""，多数接口会当成非法值报错；也不能整个参数不传——
    有的上游会直接回 400「请传递 size 参数，支持 auto 或具体图片宽高」。
    """
    return {"size": size or "auto"}


def _named_buffer(data: bytes, name: str, fallback: str) -> io.BytesIO:
    buf = io.BytesIO(data)
    buf.name = os.path.basename(name or "") or fallback
    return buf


def _is_multi_image_unsupported(error: Exception) -> bool:
    """判断报错是否来自「接口不接受图片数组」，用于决定是否退回单图模式。"""
    text = str(error).lower()
    keywords = (
        "image",
        "images",
        "array",
        "list",
        "multiple",
        "expected",
        "invalid_request",
        "unsupported",
        "too many",
        "must be",
    )
    return any(word in text for word in keywords)


def edit_image_with_references(
    settings: dict,
    main_image_bytes: bytes,
    main_image_name: str,
    reference_images: list[tuple[bytes, str]],
    prompt: str,
    negative_prompt: str,
    model: str,
    size: str,
    quality: str,
    reference_notes: list[str] | None = None,
) -> dict:
    """主图 + 参考图编辑。

    优先把主图和参考图一起作为 `image` 数组提交（gpt-image 系列支持多图输入）；
    若接口拒绝数组，则退回「只传主图 + 文字描述参考特征」。

    返回 {"files": [...], "reference_mode": "inline" | "text"}。
    """
    if not reference_images:
        files = edit_image(
            settings, main_image_bytes, main_image_name,
            prompt, negative_prompt, model, size, quality,
        )
        return {"files": files, "reference_mode": "none"}

    client = get_client(settings)
    notes = list(reference_notes or [])
    # 让 notes 与参考图数量对齐，避免提示词错位。
    if len(notes) < len(reference_images):
        notes += [""] * (len(reference_images) - len(notes))
    notes = notes[: len(reference_images)]

    inline_prompt = build_reference_prompt(prompt, negative_prompt, notes, inline_references=True)
    payload = [_named_buffer(main_image_bytes, main_image_name, "main.png")]
    for index, (data, name) in enumerate(reference_images, start=1):
        payload.append(_named_buffer(data, name, f"reference_{index}.png"))

    try:
        response = client.images.edit(
            model=model, image=payload, prompt=inline_prompt, quality=quality,
            **_size_kwargs(size)
        )
        files = [save_image_bytes(_item_to_bytes(item), "edited") for item in response.data]
        return {"files": files, "reference_mode": "inline"}
    except Exception as error:  # noqa: BLE001 - 需要按报错内容决定回退策略
        if not _is_multi_image_unsupported(error):
            diag.log_exception(
                "backend.images", "多图编辑失败", error,
                model=model, reference_count=len(reference_images),
            )
            raise
        # 上游不支持多图，走文字描述回退。这条日志能解释为什么参考图效果变弱。
        diag.log_event(
            "WARNING", "backend", f"上游不支持多图输入，回退为文字描述参考：{error}",
            logger="backend.images", model=model, reference_count=len(reference_images),
        )

    # 回退：接口只接受单张图，把参考特征写进提示词。
    text_prompt = build_reference_prompt(prompt, negative_prompt, notes, inline_references=False)
    buf = _named_buffer(main_image_bytes, main_image_name, "main.png")
    try:
        response = client.images.edit(
            model=model, image=buf, prompt=text_prompt, quality=quality,
            **_size_kwargs(size)
        )
    except Exception as error:
        diag.log_exception(
            "backend.images", "单图回退编辑失败", error,
            model=model, reference_count=len(reference_images),
        )
        raise
    files = [save_image_bytes(_item_to_bytes(item), "edited") for item in response.data]
    return {"files": files, "reference_mode": "text"}


def delete_files(filenames: list[str]):
    for name in filenames:
        # 防止路径穿越
        safe = os.path.basename(name)
        path = os.path.join(IMAGES_DIR, safe)
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError as error:
                # 删不掉通常是文件被占用，记下来才能解释「删了还在」。
                diag.log_event(
                    "WARNING", "backend", f"删除图片失败：{error}",
                    logger="backend.images", filename=safe,
                )
