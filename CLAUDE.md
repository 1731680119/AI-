# 给 AI 的项目规则

## 开工前

先读 [origin resource/docs/00-AI-上手索引.md](origin%20resource/docs/00-AI-上手索引.md)，用里面的任务路由表定位文件，别从头扫源码。逐文件说明在 [06-文件地图.md](origin%20resource/docs/06-文件地图.md)。

## 三条硬规则

1. **源码只在 `origin resource/`**。`source/frontend/` 和 `source/backend/` 是构建产物副本，改那里下次构建就被覆盖。
2. **改完代码必须同步更新文档**，按 [08-变更记录.md](origin%20resource/docs/08-变更记录.md) §1 的四步走：写变更记录 → 更新对应文档 → 检查 00 的路由表 → 只改动过的地方。文档不更新，下一个 AI 就得重读全部源码，这套文档就白写了。
3. 改完至少验证一次：
   ```bash
   cd "origin resource/frontend" && npm run build
   python -m compileall -q -x "\.venv|data" "origin resource/backend"
   ```

## 改动前必看

- `.model-menu`（`frontend/src/styles/chat.css`）是**向上弹出**的，为贴底部的输入框设计。顶栏菜单要在 `styles/shared-components.css` 加作用域覆盖（参考 `.export-select .model-menu`），**不要动 `.model-menu` 本身**。
- `source/desktop/page-enhancements.js` 靠 CSS 类名定位注入点（`.enh-settings-slot`、`.modal-footer .btn-primary` 等）。React 侧改结构类名必须同步改注入脚本，否则桌面端 UI 静默消失，且只有装成桌面版才暴露。清单见 07 §4。
- 加桌面能力要动三处：`main.cjs` 的 `ipcMain.handle` → `preload.cjs` 暴露 → 页面调用。漏一处静默失效。
- 前端改完要 `npm run build` 并把 `frontend/dist/` 同步到 `source/frontend/`，否则安装包里还是旧界面。验证方式：grep `source/frontend/assets/*.css` 里的关键字符串。
- 改字段的顺序：后端 `database.py` 的 `DEFAULT_SETTINGS` 或表结构 → `frontend/src/types/index.ts` → store → 组件。别用 `any` 绕过类型报错。
- API Key 不要写进代码、日志或提交。`backend/logging_config.py` 有脱敏（`redact`、`mask_secret`），新增日志字段要确认经过它。

## 需要先问用户

- 运行 `source/release/` 里的安装包（会覆盖已安装版本）。
- 删除或覆盖 `release/` 里的历史安装包。
- 改数据库表结构（会影响用户已有的 `%LOCALAPPDATA%\AI Chatbot\data\chatbot.db`）。
- 提交或推送（除非用户明确要求）。
