"""代码执行的确认接口。

执行本身发生在 SSE 流里（code_exec.run_tool 停在等待上），确认结果却要经
另一条 HTTP 请求进来，所以需要这个独立端点把两边接上。
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import code_exec


router = APIRouter(prefix="/api/code-exec", tags=["code-exec"])


class DecisionBody(BaseModel):
    request_id: str
    approved: bool
    # 用户在确认框里改过代码时带上改后的版本；后端会重新做一遍静态检查。
    code: str | None = None
    # 勾选了「本轮对话内不再询问」。只在批准时有意义。
    trust_conversation: bool = False
    conversation_id: str | None = None

    model_config = {"extra": "forbid"}


@router.post("/decision")
def submit_decision(body: DecisionBody):
    if body.approved and body.trust_conversation and body.conversation_id:
        code_exec.trust_conversation(body.conversation_id)
    if not code_exec.submit_decision(body.request_id, body.approved, body.code):
        # 请求已经超时或被取消，此时前端的对话框应当自己关掉。
        raise HTTPException(status_code=404, detail="确认请求已过期")
    return {"ok": True}


@router.post("/revoke-trust")
def revoke_trust(conversation_id: str):
    """撤销某个会话的免询问授权。关掉总开关或用户主动撤销时调用。"""
    code_exec.revoke_conversation(conversation_id)
    return {"ok": True}
