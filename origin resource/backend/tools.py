"""工具注册表：声明有哪些工具、以及每个工具怎么执行。

两类工具的区别值得写清楚，因为它决定了执行流程：

  * 客户端执行（本文件负责的这类）：主模型返回一个 tool_calls，后端在本地
    跑出结果，再把结果作为 role="tool" 的消息回填，让模型接着写。
  * 服务端内置（如 DeepSeek Responses 的 web_search）：请求发出去就自带结果，
    调用方无需执行。这类工具不进本注册表，由对应 provider 自己处理。

联网搜索在本项目里属于第一类——主对话走 /chat/completions，声明的是普通
function；后端接住调用后再去 DeepSeek 的 /responses 跑服务端搜索。也就是说
「服务端内置」这件事被封在 web_search.py 里，对主循环是透明的。
"""
from typing import Any
from typing import Callable
from typing import Generator

import code_exec
import logging_config as diag
import memory
import web_search


# 工具执行器统一签名：(settings, arguments, context) -> Generator[事件, None, 最终结果]
# 用生成器而不是普通函数，是为了让执行过程中的进度（例如正在打开哪个网页）
# 能实时推给前端，而不是等工具跑完才有反馈。
# context 是本轮对话的信息（如 conversation_id），模型给不了这些，由调用方注入。
Executor = Callable[[dict, dict, dict], Generator[dict, None, dict]]


class ToolError(Exception):
    """工具执行失败。消息会作为 tool 结果回填给模型，让它自己决定如何应对。"""


def _run_web_search(
    settings: dict, arguments: dict, context: dict | None = None
) -> Generator[dict, None, dict]:
    query = (arguments.get("query") or "").strip()
    if not query:
        raise ToolError("缺少 query 参数")

    result: dict[str, Any] | None = None
    # 搜索配置可以存多套，这里只用当前选中的那套；失败也不自动换下一套，
    # 免得用户不知情地在另一家上按量花钱。
    for event in web_search.search(web_search.active_provider(settings), query):
        if event["type"] == "progress":
            yield event
        elif event["type"] == "error":
            raise ToolError(event["message"])
        elif event["type"] == "result":
            result = event

    if not result:
        raise ToolError("搜索未返回结果")

    # 回填给模型的是检索结论加来源清单。模型据此作答并复述来源，
    # 前端另外用 sources 渲染来源卡片。
    lines = [result["text"]]
    if result["sources"]:
        lines.append("\n可引用的来源：")
        lines.extend(f"- {item['url']}" for item in result["sources"])
    return {
        "content": "\n".join(lines),
        "display": {
            "text": web_search.linkify_bare_urls(result["text"]),
            "sources": result["sources"],
            "usage": result.get("usage") or {},
        },
    }


def _run_remember(
    settings: dict, arguments: dict, context: dict | None = None
) -> Generator[dict, None, dict]:
    try:
        return (yield from memory.run_tool(settings, arguments, context))
    except ValueError as error:
        # 参数不合法要作为工具结果回填，让模型自己改，而不是中断整轮回答。
        raise ToolError(str(error)) from error


def _run_code(
    settings: dict, arguments: dict, context: dict | None = None
) -> Generator[dict, None, dict]:
    try:
        return (yield from code_exec.run_tool(settings, arguments, context))
    except code_exec.CodeRejected as error:
        # 拒绝的理由要回填给模型：它据此换个写法，而不是整轮回答中断。
        raise ToolError(str(error)) from error


_REGISTRY: dict[str, dict] = {
    web_search.TOOL_NAME: {
        "schema": web_search.TOOL_SCHEMA,
        "executor": _run_web_search,
        # 没配密钥时不声明这个工具，否则模型会调用一个必然失败的工具。
        "available": web_search.is_configured,
    },
    memory.TOOL_NAME: {
        "schema": memory.TOOL_SCHEMA,
        "executor": _run_remember,
        # 记忆关闭、或只允许手工维护时不声明。
        "available": memory.is_configured,
    },
    code_exec.TOOL_NAME: {
        "schema": code_exec.TOOL_SCHEMA,
        "executor": _run_code,
        # 总开关默认关；关着时不声明，模型就不会去调一个必然被拒的工具。
        "available": code_exec.is_configured,
    },
}


def available_schemas(settings: dict) -> list[dict]:
    """返回当前配置下可以声明给模型的工具列表。为空时调用方应省略 tools 参数。

    是否可用由每个工具自己的 available 决定，没有全局开关——各功能的开关
    在设置里是分开的，混成一个会让关掉联网顺带关掉记忆。
    """
    schemas = []
    for name, entry in _REGISTRY.items():
        checker = entry.get("available")
        if checker and not checker(settings):
            diag.log_event(
                "DEBUG", "backend", "工具未启用，跳过声明", logger="backend.tools", tool=name
            )
            continue
        schemas.append(entry["schema"])
    return schemas


def execute(
    settings: dict, name: str, arguments: dict, context: dict | None = None
) -> Generator[dict, None, dict]:
    """执行一个工具。产出进度事件，返回 {"content": 回填文本, "display": 前端展示数据}。"""
    entry = _REGISTRY.get(name)
    if not entry:
        raise ToolError(f"未知工具：{name}")
    return (yield from entry["executor"](settings, arguments, context or {}))
