"""集中导出所有路由，main.py 只需要遍历 ALL_ROUTERS。"""
from .chat import router as chat_router
from .code_exec import router as code_exec_router
from .conversations import router as conversations_router
from .diagnostics import router as diagnostics_router
from .images import router as images_router
from .memories import router as memories_router
from .migration import router as migration_router
from .projects import router as projects_router
from .settings import router as settings_router
from .uploads import router as uploads_router


# 新增一类 API 时，在这里导入并加入列表即可挂载到应用。
ALL_ROUTERS = [
    settings_router,
    projects_router,
    memories_router,
    conversations_router,
    uploads_router,
    chat_router,
    code_exec_router,
    images_router,
    migration_router,
    diagnostics_router,
]
