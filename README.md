# AI Chatbot

一个在本机运行的 AI 聊天与图片生成桌面应用：Electron 外壳 + React/TypeScript 前端 + Python(FastAPI) 后端。
支持流式回答、思考过程、文件上传、对话分支、代码预览、联网搜索、长期记忆、图片生成与图片编辑。

所有对话记录、上传文件和生成的图片都存在本机（`%LOCALAPPDATA%\AI Chatbot\data\`），不会随仓库分发。
API Key 由你自己填写，可以放在 `.env` 里，也可以启动后在应用的“设置”页面填。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| [origin resource/](origin%20resource/) | 源码：`frontend/`（React + Vite + TS）、`backend/`（Python FastAPI）、`docs/`（中文维护文档） |
| [source/](source/) | 桌面端打包工程：Electron 主进程 / preload（`desktop/`）与 electron-builder 配置（`package.json`） |

构建产物、依赖目录（`node_modules/`、`.venv/`）、安装包和用户数据都不入库，需要时按文档重新生成。

## 快速开始

环境要求：Python 3.11+、Node.js 20 LTS+。

终端 A，后端（监听 `127.0.0.1:8010`）：

```bat
cd "origin resource\backend"
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe main.py
```

终端 B，前端（打开 `http://localhost:5180`，`/api` 请求由 Vite 转发到 8010）：

```bat
cd "origin resource\frontend"
npm install
npm run dev
```

开发模式、打包安装包的完整步骤见 [origin resource/README.md](origin%20resource/README.md)。

## 文档

想改代码的话，**先读 [AI 上手索引](origin%20resource/docs/00-AI-上手索引.md)**：里面有任务路由表，按你要做的事直接告诉你该看哪几个文件，不用把整个仓库读一遍。

- [00 AI 上手索引](origin%20resource/docs/00-AI-上手索引.md) — 入口、任务路由表、易踩的坑
- [01 零基础维护手册](origin%20resource/docs/01-零基础维护手册.md) — 概念扫盲与目录全景
- [02 架构与数据流](origin%20resource/docs/02-架构与数据流.md) — 分层、发消息全流程、SSE 协议、消息树
- [03 常见修改操作](origin%20resource/docs/03-常见修改操作.md) — 加设置项、加接口、加字段的固定步骤
- [04 接口与数据字典](origin%20resource/docs/04-接口与数据字典.md) — 全部 API 与主要字段
- [05 故障排查](origin%20resource/docs/05-故障排查.md) — 报错与功能不生效
- [06 文件地图](origin%20resource/docs/06-文件地图.md) — 每个文件的作用与关键函数位置
- [07 桌面端与打包](origin%20resource/docs/07-桌面端与打包.md) — Electron、IPC、多 API 切换、打包
- [08 变更记录](origin%20resource/docs/08-变更记录.md) — 历史改动与文档维护规范

## 许可证

[MIT](LICENSE)
