"""SSE 流式聊天接口。"""
import json
import threading
from collections.abc import Iterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import context_service
import database as db
import llm
import logging_config as diag
import memory
import tools


router = APIRouter(prefix="/api", tags=["chat"])


class ChatBody(BaseModel):
    conversation_id: str
    content: str = ""
    attachments: list[dict] = Field(default_factory=list)
    model: str | None = None
    parent_id: str | None = None
    regenerate_from: str | None = None
    # 继续生成：把新内容续写进这条已有的回答，而不是另起一条。
    continue_from: str | None = None
    # 本次请求的思考档位；不传就用设置里的默认档位。
    thinking: str | None = None


def sse(data: dict) -> str:
    """把一个 Python 字典编码为浏览器可识别的 SSE 事件。"""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _build_message_path(conversation_id: str, end_message_id: str) -> list[dict]:
    """从指定消息向上回溯到根节点，得到发给模型的上下文。"""
    tree = db.get_conversation_tree(conversation_id)
    by_id = {message["id"]: message for message in tree["messages"]}
    path = []
    current = by_id.get(end_message_id)
    while current:
        path.append(current)
        current = by_id.get(current["parent_id"]) if current["parent_id"] else None
    path.reverse()
    return path


PROJECT_BLOCK_TEMPLATE = (
    "本次对话属于项目「{name}」。以下是该项目的专属指令，"
    "在本次对话中始终遵守：\n{instructions}"
)


def _system_extras(tree: dict, settings: dict) -> list[str]:
    """长期记忆、项目指令与回答风格，作为附加的 system 约束拼在全局提示词之后。

    顺序是从「一直成立」到「只在本轮成立」：记忆是跨会话事实，项目指令限定
    当前项目，风格只影响措辞，越靠后越具体。
    """
    extras: list[str] = []
    # 记忆是「按会话选用」的：会话没打开开关就一条都不带。注意这与设置里的
    # memory_enabled 是两层开关——那个管功能本身，这个管当前这段对话。
    if tree.get("memory_enabled"):
        memory_block = memory.build_block(settings, tree.get("memory_ids") or [])
        if memory_block:
            extras.append(memory_block)
    project_id = tree.get("project_id")
    if project_id:
        project = db.get_project(project_id)
        # 项目可能已被删除；这时只是没有专属指令，不该让对话失败。
        if project and (project.get("instructions") or "").strip():
            extras.append(PROJECT_BLOCK_TEMPLATE.format(
                name=project.get("name") or "未命名",
                instructions=project["instructions"].strip(),
            ))
    style = db.style_prompt(settings, tree.get("style_id"))
    if style:
        extras.append(style)
    return extras


CONTINUE_PROMPT = (
    "上一条回答被截断了。请从断点处直接接着写完，"
    "不要重复已经写过的内容，也不要重新开头或加上「续」之类的说明。"
)


@router.post("/chat")
def chat(body: ChatBody):
    settings = db.get_settings()
    model = body.model or settings["default_model"]
    conversation_id = body.conversation_id
    tree = db.get_conversation_tree(conversation_id)
    if not tree:
        raise HTTPException(404, "会话不存在")

    is_first_message = not any(message["role"] == "user" for message in tree["messages"])

    continue_target = None
    if body.continue_from:
        # 继续生成不新建任何消息：上下文照旧走到原来那条用户消息，
        # 再把已写出的部分和续写要求附在后面，新内容直接追加进原回答。
        by_id = {message["id"]: message for message in tree["messages"]}
        continue_target = by_id.get(body.continue_from)
        if not continue_target or continue_target["role"] != "assistant":
            raise HTTPException(400, "无效的继续生成目标")
        if not (continue_target.get("content") or "").strip():
            raise HTTPException(400, "这条回答还是空的，无法继续")
        user_message_id = continue_target["parent_id"]
        user_message = None
    elif body.regenerate_from:
        # 重新生成时不新建用户消息，让新旧回答共享同一个父节点。
        by_id = {message["id"]: message for message in tree["messages"]}
        old_answer = by_id.get(body.regenerate_from)
        if not old_answer or old_answer["role"] != "assistant":
            raise HTTPException(400, "无效的重新生成目标")
        user_message_id = old_answer["parent_id"]
        user_message = None
    else:
        # 普通发送接在当前分支末尾；编辑重发则由前端明确指定父节点。
        parent_id = body.parent_id if body.parent_id is not None else tree["active_leaf_id"]
        user_message = db.add_message(
            conversation_id,
            "user",
            body.content,
            parent_id or None,
            attachments=body.attachments,
        )
        user_message_id = user_message["id"]

    current_path = _build_message_path(conversation_id, user_message_id)
    # 上下文超过阈值时先把靠前的历史压缩成摘要，再拼装请求体。
    api_messages, context_info = context_service.build_context(
        conversation_id, current_path, settings, model,
        system_extras=_system_extras(tree, settings),
    )
    if continue_target:
        api_messages = api_messages + [
            {"role": "assistant", "content": continue_target["content"]},
            {"role": "user", "content": CONTINUE_PROMPT},
        ]

    def event_stream() -> Iterator[str]:
        # 继续生成沿用原回答；普通请求先写入空回答，流结束后再补完整内容。
        assistant = continue_target or db.add_message(
            conversation_id, "assistant", "", user_message_id, model=model
        )
        yield sse({
            "type": "start",
            "user_message": user_message,
            "assistant_message_id": assistant["id"],
        })
        if context_info.get("compacted") or context_info.get("error"):
            yield sse({"type": "context_compacted", "context": context_info})

        content = ""
        thinking = ""
        tool_calls: list = []
        persisted = False

        def persist() -> None:
            # 把当前已累积的内容落库。无论流是正常结束还是被用户中途中断
            # （客户端断开会让本生成器在 yield 处收到 GeneratorExit），都必须执行，
            # 否则中断时已经生成出来的正文会全部丢失，只剩一条空回答。
            final_content = content
            final_thinking = thinking
            final_tools = tool_calls
            if continue_target:
                # 续写直接拼在原文后面：模型是从断点处接着写的，中间不加分隔。
                final_content = continue_target["content"] + content
                final_thinking = "\n\n".join(
                    part for part in (continue_target.get("thinking"), thinking) if part
                )
                final_tools = (continue_target.get("tool_calls") or []) + tool_calls
            db.update_message(
                assistant["id"],
                content=final_content,
                thinking=final_thinking or None,
                tool_calls=final_tools,
            )

        # 每个工具各自判断是否可用，没配好的（如缺搜索密钥）不会声明给模型。
        tool_schemas = tools.available_schemas(settings)
        run_tool = None
        if tool_schemas:
            # conversation_id 模型给不了，由这里注入：remember 要记下记忆来自哪次对话。
            tool_context = {"conversation_id": conversation_id}

            def run_tool(name, arguments):
                return (yield from tools.execute(settings, name, arguments, tool_context))

        try:
            last_flush = 0
            for event in llm.stream_chat(
                settings, model, api_messages, tool_schemas=tool_schemas, run_tool=run_tool,
                effort=llm.reasoning_effort(settings, body.thinking),
            ):
                # 实时累积：即使没等到 done 事件就被中断，也已经攒下了正文和思考。
                # done 到达时再用它的权威全量值覆盖一遍。
                if event["type"] == "content":
                    content += event.get("text") or ""
                elif event["type"] == "thinking":
                    thinking += event.get("text") or ""
                elif event["type"] == "done":
                    content = event["content"]
                    thinking = event["thinking"]
                    tool_calls = event.get("tool_calls") or []
                yield sse(event)
                # 增量落库：客户端中断时，Starlette 在线程池里迭代本同步生成器，
                # 不会及时向它抛 GeneratorExit，下面 finally 的兜底要等 GC 才触发。
                # 所以必须边流边存——每多攒够一批字符就写一次库，这样中断后库里
                # 至少留着最后一次刷新的内容，不至于整段正文全部丢光。
                produced = len(content) + len(thinking)
                if produced - last_flush >= 200:
                    persist()
                    last_flush = produced

            # 只有正常跑完（没被中断）才走到这里：落库并生成标题。
            persist()
            persisted = True

            if is_first_message and body.content:
                # 标题生成失败不应阻塞回答，因此放到独立线程并设置最长等待时间。
                title_thread = threading.Thread(
                    target=lambda: db.rename_conversation(
                        conversation_id,
                        llm.generate_title(settings, model, body.content),
                    ),
                    daemon=True,
                )
                title_thread.start()
                title_thread.join(timeout=15)
                conversations = {item["id"]: item for item in db.list_conversations()}
                title = conversations.get(conversation_id, {}).get("title")
                yield sse({"type": "title", "title": title})
        finally:
            # 被中断时上面的 persist() 没机会执行，这里兜底保存已生成的部分。
            # persist 本身出错不能再往外抛，否则会掩盖真正的 GeneratorExit。
            if not persisted:
                try:
                    persist()
                except Exception as error:  # noqa: BLE001
                    diag.log_exception(
                        "backend.chat", "中断后保存部分回答失败", error,
                        conversation_id=conversation_id,
                    )


    return StreamingResponse(event_stream(), media_type="text/event-stream")
