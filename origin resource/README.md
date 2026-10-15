# AI 助手项目（源码）

这是一个在本机运行的 AI 聊天与图片生成工具，支持流式回答、思考过程、文件上传、对话分支、代码预览、联网搜索、长期记忆、图片生成和图片编辑。

程序已经是独立的 Windows 桌面应用（Electron 外壳 + 打包成 exe 的 Python 后端），不再需要手动开浏览器访问本地端口。

## 这个目录是什么

`origin resource` 只保留源码。依赖目录、构建产物和运行数据都已经清掉，需要时按下面的命令重新生成：

| 内容 | 位置 | 怎么恢复 |
| --- | --- | --- |
| 前端依赖 | `frontend/node_modules/` | `npm install` |
| 后端依赖 | 自建虚拟环境 | `pip install -r backend/requirements.txt` |
| 前端构建产物 | `frontend/dist/` | `npm run build` |
| 后端 exe | `backend/dist/` | `pyinstaller chatbot-backend.spec` |
| 聊天记录、上传文件、图片 | `%LOCALAPPDATA%\AI Chatbot\data\` | 由应用自己维护，不在源码里 |

桌面端的打包工程在同级的 `../source` 目录（Electron 主进程、preload、electron-builder 配置）。改前端或后端之后，要把构建产物复制过去才会进安装包，见下面的“打包安装包”。

## 环境准备

1. 安装 [Python](https://www.python.org/downloads/) 3.11 或更高版本，安装时勾选 `Add Python to PATH`。
2. 安装 [Node.js](https://nodejs.org/) 20 LTS 或更高版本。

## 开发模式

改代码时用这套流程，前端有热更新，不用每次打包。需要两个终端。

终端 A，启动后端（监听 `127.0.0.1:8010`）：

```bat
cd backend
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe main.py
```

终端 B，启动前端（打开 `http://localhost:5180`）：

```bat
cd frontend
npm install
npm run dev
```

Vite 会把页面发出的 `/api` 请求转发到 8010 端口，转发配置在 `frontend/vite.config.ts`。首次使用先进“设置”填写 API 地址、密钥和模型名。

虚拟环境和 `node_modules` 只需装一次，之后每次开发直接跑最后一条启动命令。

## 改完后的检查

提交或打包之前至少跑这两条，能挡掉大部分低级错误：

```bat
cd frontend && npm run build
python -m compileall -q -x "\.venv|data" backend
```

前一条等于 `tsc -b && vite build`，类型错误和构建错误都会在这里暴露。后一条只检查 Python 语法，不会真的调用模型接口，所以功能仍然要在应用里实际点一遍。

## 打包安装包

三步，顺序不能反：

1. **构建前端**，把产物复制进桌面工程。

   ```bat
   cd frontend
   npm run build
   ```

   然后用 `frontend/dist/` 的内容覆盖 `../source/frontend/`（包含 `index.html` 和 `assets/`，注意删掉旧的 `assets/index-*.js` 和 `index-*.css`，文件名带哈希不会自动覆盖）。

2. **构建后端 exe**。需要一个装了打包依赖的虚拟环境，版本按 `requirements-installer.txt` 锁定：

   ```bat
   python -m venv .buildvenv
   .buildvenv\Scripts\python.exe -m pip install -r backend\requirements-installer.txt pyinstaller
   cd backend
   ..\.buildvenv\Scripts\pyinstaller.exe --noconfirm chatbot-backend.spec
   ```

   把生成的 `backend/dist/chatbot-backend.exe` 复制成 `../source/backend/chatbot-backend.exe`。

3. **打安装包**。改 `../source/package.json` 里的 `version`，然后：

   ```bat
   cd ..\source
   npm run dist
   ```

   产物是 `source/release/AI-Chatbot-Setup-<版本号>.exe`。

只改了前端就只需要第 1 步和第 3 步；只改了后端 Python 就只需要第 2 步和第 3 步。

## 模型检测

聊天和图片渠道提供「检测可用模型」，支持模型搜索的配置提供「获取模型」：填好地址和密钥后，后端读取上游 `/models` 并筛选型号。Kimi、GLM 使用独立搜索服务，无需获取聊天模型；DeepSeek 官方不提供内置搜索。这一步只读清单，不发对话请求。

清单里有不等于调得动——中转站常见「上架了但当前分组没有渠道」「已经下架」「名字要带前缀」。所以聊天那一栏的每行还有一个「测试」按钮，会真发一次 `max_tokens=16` 的最短请求，通过才说明这个模型确实能用，失败时直接显示上游的原文报错。

## 联网搜索

搜索使用独立服务，不需要浏览器扩展。在设置的“联网搜索”里单独配置地址、密钥、协议和模型：千问使用 DashScope 原生或受支持的 Responses API；Kimi、GLM 使用各自的独立搜索接口，无需填写聊天模型。DeepSeek 官方目前不执行内置联网搜索，聊天仍可使用 DeepSeek。

搜索配置可以存多套，列表里选中的那一套才会被使用；失败时不会自动切换服务。“获取模型”仅读取清单：千问自动从原生地址转换到同地域、同业务空间的兼容模型清单路径，并过滤不支持搜索的型号；清单接口不存在时显示官方文档候选，明确提示尚未验证当前密钥与地域权限。“检索测试”使用当前草稿真实检索，不必先保存，只有拿到接口返回的来源链接才算通过。

千问支持 API 类型与搜索策略选择，按模型动态显示可用选项。切换模型会自动适配文本/多模态端点、消息格式、流式输出、输出上限及策略参数：Omni 仅显示 `agent`；Qwen3.8 普通系列的原生接口只显示 `turbo`、`max`；文档支持网页抓取的型号才显示 `agent_max`，并自动启用思考。`agent`/`agent_max` 不发送不兼容的强制搜索参数。Responses 使用 `web_search` 工具，不显示或发送 `search_strategy`。OpenAI Chat Completions 不返回千问搜索来源，因此不在可验证检索的 API 类型中。

能力规则按官方文档维护，前后端共用 `backend/search_capabilities.json`（2026-10-15 核对）。千问规则见 [联网搜索](https://help.aliyun.com/zh/model-studio/web-search) 与 [网页抓取](https://help.aliyun.com/zh/model-studio/web-extractor)；新增型号需要更新目录。Realtime 型号需要实时 API，不适用于此处。其他供应商的参数、接口和迁移说明见 [供应商核对记录](docs/09-联网搜索供应商核对.md)：Kimi Basic/Pro 分别解析正文；智谱国内使用 `search_pro`，Z.AI 国际站自动使用 `search-prime`；Coding Plan/MCP 地址不能复用于独立 REST 搜索。

不少中转站只转发 `/chat/completions`，根本没实现 Responses 接口（检测会回 `not implemented`），这类上游即使提供了名字带 `-search` 的模型也用不上本功能。

模型会自动判断是否需要检索，也可以在提问里明确要求“请联网检索”或“不要联网”。搜索结果由服务端塞进上下文，一次联网问答的输入量可能是普通对话的十几倍，所以每套配置都有“单次搜索输出上限”用来限制单次搜索的输出预算。

## 文档入口

- [零基础维护手册](docs/01-零基础维护手册.md)：从“什么是前端和后端”开始理解项目。
- [架构与数据流](docs/02-架构与数据流.md)：解释一次聊天请求如何走完整个系统。
- [常见修改操作](docs/03-常见修改操作.md)：照步骤修改文案、样式、设置项、接口和新功能。
- [接口与数据字典](docs/04-接口与数据字典.md)：查询 API、数据类型和数据库表。
- [故障排查](docs/05-故障排查.md)：按现象定位启动、网络、模型和页面问题。

## 最常用目录

```text
important resource/
├─ origin resource/            源码（本目录）
│  ├─ frontend/                界面
│  │  └─ src/
│  │     ├─ app/               页面总装和启动初始化
│  │     ├─ components/        跨功能复用的界面组件
│  │     ├─ features/          按聊天、图片、设置等功能分组
│  │     ├─ services/api/      调用后端接口
│  │     ├─ store/             全站共享状态和业务动作
│  │     ├─ styles/            按功能拆分的样式
│  │     └─ types/             前后端数据格式
│  ├─ backend/
│  │  ├─ main.py               后端入口，只负责组装应用
│  │  ├─ routers/              按功能拆分的 HTTP 接口
│  │  ├─ database.py           SQLite 数据读写
│  │  ├─ llm.py                聊天模型调用与流式解析
│  │  ├─ web_search.py         联网搜索旁路
│  │  ├─ model_probe.py        可用模型检测（读清单 + 单个模型试调）
│  │  ├─ memory.py             长期记忆
│  │  ├─ context_service.py    上下文自动压缩
│  │  ├─ files.py              附件保存和文字提取
│  │  ├─ images.py             图片模型调用和图片保存
│  │  ├─ paths.py              所有运行数据路径
│  │  └─ chatbot-backend.spec  PyInstaller 打包配置
│  └─ docs/                    维护文档
└─ source/                     桌面端打包工程
   ├─ desktop/                 Electron 主进程、preload、注入脚本
   ├─ frontend/                前端构建产物（从 dist 复制过来）
   ├─ backend/                 chatbot-backend.exe
   └─ release/                 生成的安装包
```

## 数据安全

聊天记录和设置保存在 `%LOCALAPPDATA%\AI Chatbot\data\chatbot.db`，上传文件在同目录的 `uploads/`，生成图片在 `images/`。这个位置由桌面端通过 `CHATBOT_DATA_DIR` 环境变量指定；直接跑 `python main.py` 开发时没有这个变量，数据会落到 `backend/data/`，属于开发数据，和正式应用的数据互不影响。

升级或大改之前，请先退出程序再备份整个数据目录。

真实 API 密钥只能放在应用设置或 `.env` 中。不要把 `.env`、数据目录或包含密钥的截图提交到代码仓库。

联网搜索会把与问题相关的内容发送到所配置的搜索接口。后端会移除常见密钥、Cookie、密码、邮箱和手机号模式，但仍不建议让机器人检索包含高度敏感个人数据的内容。
