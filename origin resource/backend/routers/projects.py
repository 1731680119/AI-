"""项目接口：项目本身的增删改查，以及会话的项目归属。"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import database as db


router = APIRouter(prefix="/api/projects", tags=["projects"])


class CreateProjectBody(BaseModel):
    name: str = "新项目"
    description: str = ""
    instructions: str = ""


class UpdateProjectBody(BaseModel):
    name: str | None = None
    description: str | None = None
    instructions: str | None = None


@router.get("")
def list_projects():
    return db.list_projects()


@router.post("")
def create_project(body: CreateProjectBody):
    name = body.name.strip() or "新项目"
    return db.create_project(name, body.description, body.instructions)


@router.get("/{project_id}")
def get_project(project_id: str):
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    return project


@router.put("/{project_id}")
def update_project(project_id: str, body: UpdateProjectBody):
    if not db.get_project(project_id):
        raise HTTPException(404, "项目不存在")
    return db.update_project(
        project_id, body.name, body.description, body.instructions
    )


@router.delete("/{project_id}")
def delete_project(project_id: str, delete_conversations: bool = False):
    """默认只解除会话归属；delete_conversations=true 时连会话一起删。"""
    if not db.get_project(project_id):
        raise HTTPException(404, "项目不存在")
    db.delete_project(project_id, delete_conversations)
    return {"ok": True}
