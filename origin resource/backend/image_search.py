"""从互联网检索可展示图片，不生成或托管图片。"""
import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Generator

TOOL_NAME = "image_search"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AI-Chatbot/1.0"
_M_BLOCK = re.compile(r"<a[^>]*class=['\"]iusc['\"][^>]*\sm=['\"](.*?)['\"]", re.I)

TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": (
            "从互联网搜索并展示相关图片。适合旅游、地点、人物、动物、产品、建筑、"
            "图表等视觉主题时调用；图片来自互联网，必须保留来源网页，不要把图片当成自己生成的。"
        ),
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "图片搜索关键词"}},
            "required": ["query"],
        },
    },
}


def is_configured(settings: dict) -> bool:
    return bool(settings.get("tools_enabled", True))


def _valid_url(value: Any) -> str:
    value = str(value or "").strip()
    parsed = urllib.parse.urlsplit(value)
    return value if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def _results(raw: str, limit: int = 8) -> list[dict]:
    items: list[dict] = []
    seen: set[str] = set()
    for match in _M_BLOCK.finditer(raw):
        try:
            data = json.loads(html.unescape(match.group(1)))
        except (ValueError, TypeError):
            continue
        image_url = _valid_url(data.get("murl"))
        source_url = _valid_url(data.get("purl"))
        thumb_url = _valid_url(data.get("turl")) or image_url
        if not image_url or not source_url or image_url in seen:
            continue
        seen.add(image_url)
        items.append({
            "url": image_url, "thumbnail": thumb_url, "source_url": source_url,
            "title": str(data.get("t") or data.get("purl") or "互联网图片").strip(),
        })
        if len(items) >= limit:
            break
    return items


def search(query: str, timeout: int = 30) -> Generator[dict, None, None]:
    query = (query or "").strip()
    if not query:
        yield {"type": "error", "message": "缺少图片搜索关键词", "status": 0}
        return
    yield {"type": "progress", "action": "search", "queries": [query], "url": ""}
    url = "https://www.bing.com/images/search?form=HDRSC2&q=" + urllib.parse.quote(query)
    request = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "text/html"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
        images = _results(raw)
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        yield {"type": "error", "message": f"图片搜索失败：{error}", "status": 0}
        return
    if not images:
        yield {"type": "error", "message": "没有找到可展示的互联网图片", "status": 0}
        return
    text = "\n".join(f"{item['title']}：{item['source_url']}" for item in images)
    yield {"type": "result", "text": text, "images": images, "sources": [
        {"url": item["source_url"], "host": urllib.parse.urlsplit(item["source_url"]).netloc,
         "title": item["title"]} for item in images
    ]}
