"""从旧版本文件导入会话和图片。"""
import json
import re
import shutil
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException

import database as db
import images as image_service


router = APIRouter(prefix="/api", tags=["migration"])
# 原项目把旧数据放在 chatbot-web 的上一级目录。
LEGACY_ROOT = Path(__file__).resolve().parents[3]


@router.post("/migrate")
def migrate_conversations():
    """把旧 chat_data.json 中的线性消息转换为当前的消息链。"""
    old_path = LEGACY_ROOT / "chat_data.json"
    if not old_path.exists():
        raise HTTPException(404, "未找到 chat_data.json")
    data = json.loads(old_path.read_text(encoding="utf-8"))

    existing_titles = {conversation["title"] for conversation in db.list_conversations()}
    imported = 0
    for chat in data.get("chats", []):
        title = chat.get("title", "导入的对话")
        if title in existing_titles:
            continue
        conversation = db.create_conversation(title)
        parent_id = None
        for message in chat.get("messages", []):
            role = message.get("role")
            if role not in ("user", "assistant"):
                continue
            saved = db.add_message(
                conversation["id"], role, message.get("content", ""), parent_id
            )
            parent_id = saved["id"]
        imported += 1
    return {"imported": imported}


@router.post("/images/migrate")
def migrate_images():
    """把旧 generated_images/ 目录中的图片导入历史记录。"""
    old_directory = LEGACY_ROOT / "generated_images"
    if not old_directory.is_dir():
        raise HTTPException(404, "未找到 generated_images 目录")

    target_directory = Path(image_service.IMAGES_DIR)
    target_directory.mkdir(parents=True, exist_ok=True)
    existing_files = {
        filename for record in db.list_images() for filename in record["files"]
    }

    imported = 0
    for source in sorted(old_directory.iterdir()):
        if source.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            continue
        if source.name in existing_files:
            continue
        shutil.copy2(source, target_directory / source.name)

        mode = "edit" if source.name.startswith("edited_") else "generate"
        created_at = None
        match = re.match(r"^(?:generated|edited)_(\d{8})_(\d{6})_", source.name)
        if match:
            try:
                created_at = datetime.strptime(
                    match.group(1) + match.group(2), "%Y%m%d%H%M%S"
                ).astimezone().isoformat()
            except ValueError:
                pass
        db.add_image_record(
            mode,
            "（旧版导入，无提示词记录）",
            "",
            "",
            "",
            "",
            [source.name],
            created_at=created_at,
        )
        imported += 1
    return {"imported": imported}
