"""集中定义项目路径。

数据库、上传文件、生成图片、日志都必须从这里取路径，避免不同模块把数据
写到不同位置。可通过 CHATBOT_DATA_DIR 环境变量把数据目录改到其他磁盘。
"""
import os
from pathlib import Path


APP_NAME = "Chatbot"
BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BACKEND_DIR.parent


# 默认继续使用原项目的 backend/data，保证重构后历史数据仍在原处。
# 打包或部署时可设置 CHATBOT_DATA_DIR，例如 C:\Users\name\AppData\Local\Chatbot。
DATA_DIR = Path(os.environ.get("CHATBOT_DATA_DIR", BACKEND_DIR / "data")).resolve()
DATABASE_PATH = DATA_DIR / "chatbot.db"
UPLOAD_DIR = DATA_DIR / "uploads"
IMAGES_DIR = DATA_DIR / "images"
RUNTIME_DIR = DATA_DIR / "runtime"

# 桌面端会把 CHATBOT_LOG_DIR 指向 userData/logs，让 Electron 主进程、渲染进程
# 和后端三方的日志落在同一个目录，便于一次性打包导出。
LOG_DIR = Path(os.environ.get("CHATBOT_LOG_DIR", DATA_DIR / "logs")).resolve()

# 开发时由 Vite 提供页面；构建后 dist 会位于 frontend/dist。
FRONTEND_DIST = Path(
    os.environ.get("CHATBOT_FRONTEND_DIST", PROJECT_DIR / "frontend" / "dist")
).resolve()


def ensure_data_dirs() -> None:
    for directory in (DATA_DIR, UPLOAD_DIR, IMAGES_DIR, LOG_DIR, RUNTIME_DIR):
        directory.mkdir(parents=True, exist_ok=True)
