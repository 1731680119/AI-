"""会话列表、消息树和分支切换接口。"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import database as db


router = APIRouter(prefix="/api/conversations", tags=["conversations"])


class RenameBody(BaseModel):
    title: str


class ActiveLeafBody(BaseModel):
    leaf_id: str


class CreateConversationBody(BaseModel):
    project_id: str | None = None
    style_id: str | None = None
    # 新会话默认不带记忆。前端在输入框上先开了开关再发第一条消息时，
    # 这两个字段才会有值——否则一路走默认，和「新对话记忆默认关闭」一致。
    memory_enabled: bool = False
    memory_ids: list[str] | None = None


class ProjectBody(BaseModel):
    project_id: str | None = None


class StyleBody(BaseModel):
    style_id: str | None = None


class MemoryBody(BaseModel):
    enabled: bool = False
    memory_ids: list[str] = []


@router.get("")
def list_conversations():
    return db.list_conversations()


def _snippet(content: str, query: str, radius: int = 40) -> str:
    """截取命中位置周围的一小段，两侧超出的部分用省略号标记。"""
    text = " ".join((content or "").split())
    pos = text.lower().find(query.lower())
    if pos < 0:  # 命中在被折叠的空白里，退化成开头一段
        return text[: radius * 2] + ("…" if len(text) > radius * 2 else "")
    start = max(0, pos - radius)
    end = min(len(text), pos + len(query) + radius)
    return ("…" if start > 0 else "") + text[start:end] + ("…" if end < len(text) else "")


# 这条要放在 /{conversation_id} 之前声明，否则 search 会被当成会话 id。
@router.get("/search")
def search_conversations(q: str = "", limit: int = 60):
    """按消息正文搜索，返回每个会话的一条命中片段。"""
    hits = db.search_messages(q, limit=limit)
    return [
        {
            "conversation_id": h["conversation_id"],
            "title": h["title"],
            "project_id": h["project_id"],
            "updated_at": h["updated_at"],
            "message_id": h["message_id"],
            "role": h["role"],
            "match_count": h["match_count"],
            "snippet": _snippet(h["content"], q.strip()),
        }
        for h in hits
    ]


@router.post("")
def create_conversation(body: CreateConversationBody | None = None):
    body = body or CreateConversationBody()
    if body.project_id and not db.get_project(body.project_id):
        raise HTTPException(404, "项目不存在")
    return db.create_conversation(
        project_id=body.project_id,
        style_id=body.style_id,
        memory_enabled=body.memory_enabled,
        memory_ids=body.memory_ids,
    )


@router.get("/{conversation_id}")
def get_conversation(conversation_id: str):
    tree = db.get_conversation_tree(conversation_id)
    if not tree:
        raise HTTPException(404, "会话不存在")
    return tree


@router.put("/{conversation_id}")
def rename_conversation(conversation_id: str, body: RenameBody):
    db.rename_conversation(conversation_id, body.title)
    return {"ok": True}


@router.delete("/{conversation_id}")
def delete_conversation(conversation_id: str):
    db.delete_conversation(conversation_id)
    return {"ok": True}


@router.put("/{conversation_id}/project")
def set_conversation_project(conversation_id: str, body: ProjectBody):
    if not db.get_conversation_tree(conversation_id):
        raise HTTPException(404, "会话不存在")
    if body.project_id and not db.get_project(body.project_id):
        raise HTTPException(404, "项目不存在")
    db.set_conversation_project(conversation_id, body.project_id)
    return {"project_id": body.project_id}


@router.put("/{conversation_id}/style")
def set_conversation_style(conversation_id: str, body: StyleBody):
    if not db.get_conversation_tree(conversation_id):
        raise HTTPException(404, "会话不存在")
    db.set_conversation_style(conversation_id, body.style_id)
    return {"style_id": body.style_id}


@router.put("/{conversation_id}/memory")
def set_conversation_memory(conversation_id: str, body: MemoryBody):
    """这段对话要不要带记忆、带哪几条。

    不校验 id 是否还存在：记忆可能在别处被删掉，拼提示词时按 id 取不到自然
    就跳过了，没必要为此让开关操作失败。
    """
    if not db.get_conversation_tree(conversation_id):
        raise HTTPException(404, "会话不存在")
    db.set_conversation_memory(conversation_id, body.enabled, body.memory_ids)
    return {"memory_enabled": body.enabled, "memory_ids": body.memory_ids}


@router.put("/{conversation_id}/active_leaf")
def set_active_leaf(conversation_id: str, body: ActiveLeafBody):
    tree = db.get_conversation_tree(conversation_id)
    if not tree:
        raise HTTPException(404, "会话不存在")
    if not any(message["id"] == body.leaf_id for message in tree["messages"]):
        raise HTTPException(400, "分支不属于当前会话")
    # 用户切换到一个历史节点时，继续沿该分支找到最新的叶子消息。
    leaf_id = db.find_latest_leaf(conversation_id, body.leaf_id)
    db.set_active_leaf(conversation_id, leaf_id)
    return {"active_leaf_id": leaf_id}
