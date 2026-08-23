"""图片导出：把 data/images/ 里已生成的图转成其它格式。

设计要点：

1. **不依赖用户环境。** 转换全靠 Pillow（外加 pillow-heif 提供 HEIC/AVIF），
   两者都写在 requirements.txt 里、被 PyInstaller 打进 chatbot-backend.exe，
   用户装完安装包就能用，不需要自己 pip install 任何东西。

2. **格式清单是「探测」出来的，不是写死的。** pillow-heif 的 wheel 在不同平台上
   带的编码器不一样（尤其 AVIF 依赖 libheif 里有没有 AV1 编码器），写死清单的话
   用户会看到一个点了必然报错的选项。所以启动后第一次问清单时，对每种格式真的
   编码一张 2x2 的小图，编得出来才算数。结果缓存，只跑一次。

3. **转换只在内存里做**，返回 bytes 交给路由层直接吐给前端，不落临时文件——
   落盘就要考虑清理，而这里没有任何需要保留的中间产物。
"""
import io
import os
from functools import lru_cache

from PIL import Image


# pillow-heif 只需要注册一次；注册失败（没装 / wheel 不带编码器）不影响其余格式。
try:  # pragma: no cover - 取决于运行环境是否装了 pillow-heif
    import pillow_heif

    pillow_heif.register_heif_opener()
    if hasattr(pillow_heif, "register_avif_opener"):
        # pillow-heif 1.x 起 AVIF 由 Pillow 自己接管，这个函数可能已经没有了。
        pillow_heif.register_avif_opener()
except Exception:  # noqa: BLE001 - 缺这个库只是少两种格式，不该让后端起不来
    pillow_heif = None


# key 是前后端约定的格式标识，pil 是 Pillow 的 format 名（两者不总是一样）。
_FORMAT_TABLE = [
    {
        "key": "png", "label": "PNG", "ext": "png", "mime": "image/png", "pil": "PNG",
        "alpha": True, "quality": False, "dpi": True, "compression": False,
        "note": "无损，保留透明通道",
    },
    {
        "key": "jpeg", "label": "JPEG", "ext": "jpg", "mime": "image/jpeg", "pil": "JPEG",
        "alpha": False, "quality": True, "dpi": True, "compression": False,
        "note": "有损，体积小，不支持透明",
    },
    {
        "key": "webp", "label": "WebP", "ext": "webp", "mime": "image/webp", "pil": "WEBP",
        "alpha": True, "quality": True, "dpi": False, "compression": False,
        "note": "体积比 JPEG 更小，保留透明通道",
    },
    {
        "key": "tiff", "label": "TIFF", "ext": "tif", "mime": "image/tiff", "pil": "TIFF",
        "alpha": True, "quality": False, "dpi": True, "compression": True,
        "note": "印刷/后期常用，可选无损压缩方式",
    },
    {
        "key": "bmp", "label": "BMP", "ext": "bmp", "mime": "image/bmp", "pil": "BMP",
        "alpha": False, "quality": False, "dpi": False, "compression": False,
        "note": "无压缩位图，体积很大",
    },
    {
        "key": "gif", "label": "GIF", "ext": "gif", "mime": "image/gif", "pil": "GIF",
        "alpha": False, "quality": False, "dpi": False, "compression": False,
        "note": "最多 256 色，画质损失明显",
    },
    {
        "key": "ico", "label": "ICO 图标", "ext": "ico", "mime": "image/x-icon", "pil": "ICO",
        "alpha": True, "quality": False, "dpi": False, "compression": False,
        "note": "Windows 图标，边长会被限制在 256 以内",
    },
    {
        "key": "pdf", "label": "PDF", "ext": "pdf", "mime": "application/pdf", "pil": "PDF",
        "alpha": False, "quality": False, "dpi": True, "compression": False,
        "note": "单页文档，按 DPI 决定纸张尺寸",
    },
    {
        "key": "heic", "label": "HEIC", "ext": "heic", "mime": "image/heic", "pil": "HEIF",
        "alpha": True, "quality": True, "dpi": False, "compression": False,
        "note": "苹果设备常用，同画质下体积最小",
    },
    {
        "key": "avif", "label": "AVIF", "ext": "avif", "mime": "image/avif", "pil": "AVIF",
        "alpha": True, "quality": True, "dpi": False, "compression": False,
        "note": "新一代格式，压缩率高，旧软件可能打不开",
    },
]

_BY_KEY = {item["key"]: item for item in _FORMAT_TABLE}

# 前端下拉里的选项值 -> Pillow 的 compression 参数。
TIFF_COMPRESSION = {
    "none": None,
    "lzw": "tiff_lzw",
    "deflate": "tiff_adobe_deflate",
}

MAX_EDGE = 8192
DEFAULT_DPI = 96


class ExportError(ValueError):
    """参数不合法或转换失败。路由层会转成 400。"""


def _probe_kwargs(spec: dict) -> dict:
    """探测用的最小参数。有些格式不给参数就存不出来（比如 ICO 的 sizes）。"""
    if spec["key"] == "ico":
        return {"sizes": [(2, 2)]}
    return {}


@lru_cache(maxsize=1)
def available_formats() -> tuple[dict, ...]:
    """真正能编码出来的格式清单。首次调用会逐个试存一张 2x2 小图。"""
    result = []
    for spec in _FORMAT_TABLE:
        probe = Image.new("RGB", (2, 2), "white")
        try:
            buffer = io.BytesIO()
            probe.save(buffer, format=spec["pil"], **_probe_kwargs(spec))
            if buffer.tell() <= 0:
                continue
        except Exception:  # noqa: BLE001 - 存不出来就是这台机器上不支持
            continue
        result.append({key: value for key, value in spec.items() if key != "pil"})
    return tuple(result)


def _parse_color(value: str) -> tuple[int, int, int]:
    """解析 #RRGGBB / #RGB。给不出合法值就当白色，不因为一个配色把导出整个卡住。"""
    text = (value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6:
        return (255, 255, 255)
    try:
        return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))
    except ValueError:
        return (255, 255, 255)


def _flatten(image: Image.Image, background: str) -> Image.Image:
    """把透明通道压到纯色背景上，供 JPEG/BMP/PDF 这些不支持透明的格式使用。"""
    if image.mode not in ("RGBA", "LA", "P"):
        return image.convert("RGB")
    rgba = image.convert("RGBA")
    canvas = Image.new("RGB", rgba.size, _parse_color(background))
    canvas.paste(rgba, mask=rgba.split()[-1])
    return canvas


def _resize(image: Image.Image, width: int | None, height: int | None) -> Image.Image:
    """按需缩放。只给一边时另一边按原比例推算，两边都不给就原样返回。"""
    if not width and not height:
        return image
    src_w, src_h = image.size
    if width and not height:
        height = max(1, round(src_h * width / src_w))
    elif height and not width:
        width = max(1, round(src_w * height / src_h))
    if width > MAX_EDGE or height > MAX_EDGE:
        raise ExportError(f"导出尺寸的边长不能超过 {MAX_EDGE} 像素")
    if (width, height) == (src_w, src_h):
        return image
    return image.resize((width, height), Image.LANCZOS)


def _clamp_int(value, low: int, high: int, fallback: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def convert(
    source_path: str,
    fmt: str,
    *,
    quality: int = 92,
    tiff_compression: str = "lzw",
    dpi: int = DEFAULT_DPI,
    background: str = "#FFFFFF",
    width: int | None = None,
    height: int | None = None,
) -> tuple[bytes, str, str]:
    """转换单张图，返回 (文件内容, 建议文件名, MIME)。"""
    spec = _BY_KEY.get(fmt)
    if spec is None:
        raise ExportError(f"不支持的导出格式：{fmt}")
    if not any(item["key"] == fmt for item in available_formats()):
        raise ExportError(f"当前运行环境无法编码 {spec['label']} 格式")
    if not os.path.exists(source_path):
        raise ExportError("原图不存在，可能已被删除")

    quality = _clamp_int(quality, 1, 100, 92)
    dpi = _clamp_int(dpi, 1, 2400, DEFAULT_DPI)

    with Image.open(source_path) as opened:
        # 多帧图（GIF/动图）只取第一帧；load() 必须在 with 里做完，出了作用域文件就关了。
        opened.seek(0)
        image = opened.convert("RGBA") if "A" in opened.getbands() else opened.convert("RGB")

    image = _resize(image, width, height)
    if not spec["alpha"]:
        image = _flatten(image, background)

    save_kwargs: dict = {}
    pil_format = spec["pil"]

    if spec["dpi"]:
        save_kwargs["dpi"] = (dpi, dpi)
    if spec["quality"]:
        save_kwargs["quality"] = quality

    if fmt == "png":
        save_kwargs["optimize"] = True
    elif fmt == "jpeg":
        save_kwargs["subsampling"] = 0 if quality >= 90 else 2
        save_kwargs["progressive"] = True
    elif fmt == "webp":
        # 质量拉满时改走无损，否则 WebP 在 100 分下仍然是有损的，容易被误解。
        save_kwargs["lossless"] = quality >= 100
        save_kwargs["method"] = 4
    elif fmt == "tiff":
        if tiff_compression not in TIFF_COMPRESSION:
            raise ExportError(f"不支持的 TIFF 压缩方式：{tiff_compression}")
        compression = TIFF_COMPRESSION[tiff_compression]
        if compression:
            save_kwargs["compression"] = compression
    elif fmt == "gif":
        image = image.convert("P", palette=Image.ADAPTIVE, colors=256)
    elif fmt == "ico":
        # ICO 的边长上限是 256，超了 Pillow 会直接抛错，这里先缩到范围内。
        side = min(256, max(image.size))
        image = image.resize((side, side), Image.LANCZOS)
        save_kwargs["sizes"] = [(side, side)]
    elif fmt == "pdf":
        save_kwargs.pop("dpi", None)
        save_kwargs["resolution"] = float(dpi)

    buffer = io.BytesIO()
    try:
        image.save(buffer, format=pil_format, **save_kwargs)
    except Exception as error:  # noqa: BLE001 - 统一转成用户能看懂的提示
        raise ExportError(f"转换为 {spec['label']} 失败：{error}") from error

    stem = os.path.splitext(os.path.basename(source_path))[0]
    return buffer.getvalue(), f"{stem}.{spec['ext']}", spec["mime"]
