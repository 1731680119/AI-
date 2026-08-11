"""长期记忆接口：设置界面里手工查看与增删记忆。

模型自己写入走的是 remember 工具（memory.run_tool），不经过这里。
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import database as db
import memory


router = APIRouter(prefix="/api/memories", tags=["memories"])


class CreateMemoryBody(BaseModel):
    content: str


class UpdateMemoryBody(BaseModel):
    content: str


@router.get("")
def list_memories():
    """带上渲染后的记忆块长度，方便界面提示这部分每轮要占多少上下文。"""
    settings = db.get_settings()
    items = db.list_memories()
    return {"items": items, "block_chars": len(memory.build_block(settings))}


@router.post("")
def create_memory(body: CreateMemoryBody):
    content = body.content.strip()
    if not content:
        raise HTTPException(400, "记忆内容不能为空")
    result = memory.remember(db.get_settings(), content)
    return {
        "memory": result["memory"],
        "duplicate": result["duplicate"],
        "trimmed": result["trimmed"],
    }


@router.put("/{memory_id}")
def update_memory(memory_id: str, body: UpdateMemoryBody):
    if not db.get_memory(memory_id):
        raise HTTPException(404, "记忆不存在")
    content = body.content.strip()
    if not content:
        raise HTTPException(400, "记忆内容不能为空")
    return db.update_memory(memory_id, content[: memory.ITEM_MAX_CHARS])


@router.delete("/{memory_id}")
def delete_memory(memory_id: str):
    if not db.get_memory(memory_id):
        raise HTTPException(404, "记忆不存在")
    db.delete_memory(memory_id)
    return {"ok": True}


@router.post("/clear")
def clear_memories():
    """清空全部记忆。破坏性操作，界面上必须二次确认。"""
    db.clear_memories()
    return {"ok": True}
