# 注意事项（改动前请先读完本文件）

本文件是本仓库的第一手上下文。后续 AI 在改任何东西之前先看这里，可以省掉大量重复探索的 token，也能避免破坏目录结构。

## 1. 目录性质：分清哪些能改、哪些绝对不能改

仓库根目录 `AI Chatbot/` **本身就是已安装的应用输出目录**，不是源码目录。

| 路径 | 性质 | 能否修改 |
| --- | --- | --- |
| 根目录下 `AI Chatbot.exe`、`Uninstall AI Chatbot.exe`、`*.dll`、`*.pak`、`locales/`、`resources/`、`LICENSES.chromium.html` | 安装后的运行时产物 | **禁止修改/删除**，改了要重装才能恢复 |
| `important resource/origin resource/` | **真正的源码**（`frontend/`、`backend/`、`docs/`、`README.md`、`*.bat`） | 改这里 |
| `important resource/source/` | **打包目录**（`desktop/`、`frontend/` 构建产物、`backend/`、`electron-dist/`、`release/`） | 按下面流程改 |
| `important resource/source/electron-dist/` | 已改名的精简 Electron 发行版，只给 electron-builder 用 | **禁止改动，也不要拿它跑 app** |
| `important resource/source/release/` | 安装包输出目录，历史版本都在这里 | 新安装包放这里，别挪走、别删旧版 |
| `user-data/` | **用户真实数据**：聊天记录、API key（`chatbot.db`）、图片、上传附件。是 `%LOCALAPPDATA%\AI Chatbot\data` 的 junction 目标 | **禁止删除/清理**，详见 §10 |

注意：根目录的运行时产物（`locales/`、`*.dll`、`*.pak`、`resources/`）**已从 git 移出**，只存在于本地磁盘。
所以 clone 出来的仓库是跑不起来的，主程序靠**公开库 `1731680119/AI-` 的 Release** 分发（见 §6）。
完整方案见根目录 `多机同步说明.md`。

## 2. 改前端功能的正确流程

1. 改 `important resource/origin resource/frontend/src/...`（源码只在这里，`source/frontend` 是产物）。
2. 在 `origin resource/frontend` 执行构建：脚本是 `npm run build`（即 `tsc -b && vite build`）。首次需要先 `npm install`，该目录默认没有 `node_modules`。
3. 把 `origin resource/frontend/dist/` 的产物同步到 `important resource/source/frontend/`，打包读的是后者。
4. 在 `important resource/source` 执行 `npm run dist`（即 `electron-builder --win nsis --x64`），产物落在 `source/release/AI-Chatbot-Setup-<version>.exe`。

验证改动是否真的进了包：直接 grep `source/frontend/assets/*.css`（或 `*.js`）里的关键字符串，比重新打开界面快得多。

## 2-b. 改后端功能的正确流程（**别以为拷个 .py 就行**）

`important resource/source/backend/` 里**只有一个 `chatbot-backend.exe`**，是 PyInstaller 打的单文件产物。Python 源码不会被拷进安装包，所以**改了 `origin resource/backend/*.py` 就必须重编这个 exe**，否则改动一行都进不去，而且不会有任何报错——包能正常打出来，跑起来还是旧逻辑。

1. 改 `important resource/origin resource/backend/*.py`。
2. 在 `origin resource/backend` 建/激活虚拟环境并装依赖（新机器上没有）：

   ```bash
   python -m venv .venv
   .venv/Scripts/python.exe -m pip install -r requirements.txt pyinstaller
   ```

   `.venv/`、`build/`、`dist/` 都已在 `origin resource/.gitignore` 里，不会进仓库。
3. 编译：`.venv/Scripts/pyinstaller.exe --noconfirm chatbot-backend.spec`，产物在 `origin resource/backend/dist/chatbot-backend.exe`。
4. **先冒烟测试再替换**（换了依赖版本很可能编出个起不来的 exe，装完才发现就晚了）。务必指定临时数据目录，别让它碰 `user-data/`：

   ```bash
   TMPD=$(mktemp -d)
   CHATBOT_DATA_DIR="$TMPD" ./dist/chatbot-backend.exe --port 8733 &
   sleep 45   # 单文件 exe 冷启动要先解压几十 MB，慢是正常的
   curl -s -m 10 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8733/api/settings   # 期望 200
   MSYS_NO_PATHCONV=1 taskkill /FI "IMAGENAME eq chatbot-backend.exe" /F
   ```

5. 拷到 `important resource/source/backend/chatbot-backend.exe`，再走 §2 第 4 步打包。

## 3. 打包配置要点（`important resource/source/package.json`）

- `build.files` 只有 `desktop/**/*` 和 `package.json`；前端和后端是通过 `build.extraResources` 从 `frontend/`、`backend/` 拷进 `resources/` 的。**往 asar 里塞前端文件是错的方向。**
- `build.electronDist = "electron-dist"`，`asar: true`，NSIS 为非一键安装（`oneClick: false`、可改安装路径、`deleteAppDataOnUninstall: false`）。
- `allowScripts` 字段是有意加的（放开 electron 的 postinstall），**不要清掉**。
- 版本号只在 `source/package.json` 的 `version` 里改，安装包文件名由 `artifactName` 自动带上版本。
- **没收到「改源码提交」口令之前，一律不升版本号。** 详见 §3-b。

## 3-b. 什么时候才能升版本号（默认答案是「不升」）

**只有在用户说出「改源码提交」这句口令之后，才允许把 `source/package.json` 的 `version` 往上加。**

在那之前，无论改了多少东西、打了多少次包，版本号都**保持不动**，反复打同一个版本号的安装包，
后打的直接覆盖 `source/release/` 里同名的那个。

为什么这么定：出包 → 用户测 → 测出问题 → 回去接着改 → 再出包，这个循环可能转好几轮
（见 §6 和 `docs/08-变更记录.md` §2.1）。每轮都升一个号的话，`release/` 里会堆一串
从来没发布过、也没人装过的版本，而公开库 Release 那边只有真正发出去的那几个，
两边的版本号很快就对不上，日后排查「用户装的到底是哪一版」会非常痛苦。

具体做法：

- 每轮修改照常改代码、更文档、打包，**跳过升版本号那一步**。
- `docs/08-变更记录.md` 的记录还是要写，标题挂在**当前这个版本号**下。同一个版本号下
  已经有一条记录了，就往那条里补内容，别新起一条。
- 收到「改源码提交」后，在走 §6 的同步流程之前，先把版本号升一次，
  重新打一个包，再拿这个包去发 Release。

> 例外：用户明确说了「升到 x.y.z」之类的话，按用户说的来。

## 4. 已经踩过的坑（重复踩会浪费很多 token）

**坑一：`ELECTRON_RUN_AS_NODE`**
VSCode 扩展宿主会把这个环境变量传下来，导致 `electron.exe` 退化成普通 Node，`require('electron')` 拿不到 API，表现为 `desktop/main.cjs:47` 报 `Cannot read properties of undefined (reading 'setPath')`。
注意：设成空字符串 **无效**，必须彻底 `unset ELECTRON_RUN_AS_NODE` 再执行 electron 或 electron-builder。

**坑二：electron 二进制没装好**
`source/node_modules/electron/dist/` 为空时会报 `Electron failed to install correctly`。npm 的 allow-scripts 策略会拦住 postinstall，而且 extract-zip 可能"成功"却什么都没解出来。
解决办法：从缓存 `%LOCALAPPDATA%\electron\Cache\<hash>\electron-v37.10.3-win32-x64.zip` 手动 `Expand-Archive -LiteralPath $zip -DestinationPath dist -Force`，再写 `node_modules/electron/path.txt`，内容就一行 `electron.exe`。

**坑三：别用 `electron-dist` 调试**
它是改过名的精简发行版，没有 `default_app.asar`，`electron .` 跑不起来。要本地起应用只能用 `source/node_modules/electron` 里那套。

**坑四：新机器上 `npm install` 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`**
卡在 `electron/node-gyp` 这个 git 依赖上，Node 自带证书库里没有本机网络链路的根证书。加 `NODE_OPTIONS=--use-system-ca` 走系统信任链即可，`npm install` 和 `npm run dist` **都要加**。
别用 `strict-ssl=false` 或 `NODE_TLS_REJECT_UNAUTHORIZED=0`——那是把 TLS 校验整个关掉。

**坑五：新机器上没有 `electron-dist/`，`npm run dist` 直接失败**
`node_modules/`、`electron-dist/`、`release/` 全在 `.gitignore` 里，clone 出来**没有任何打包环境**。
`electron-dist` 要自己造：`cp -r node_modules/electron/dist electron-dist && rm -f electron-dist/resources/default_app.asar`。
版本由 `devDependencies` 锁定，且它进不了 git，所以各机器各持一份，**不会冲突**。
注意 §1 里 `electron-dist` 的「禁止改动」指的是**已存在**的那份；`ls` 报 no such file 就是新机器，可以建。

## 5. 已知的 UI 约定（改样式前必看）

`.model-menu` 在 `origin resource/frontend/src/styles/chat.css` 里是 `bottom: calc(100% + 6px)`，即**向上弹出**——这是为输入框（贴在窗口底部）设计的，输入区的模型选择器和风格选择器都依赖它，**不要直接改这条公共规则**。

顶栏（约 52px 高）里的菜单如果复用了这套 class，就会往上弹被遮住。已有的正确做法是在 `styles/shared-components.css` 里加作用域覆盖，例如对话导出菜单：

```css
.export-select .model-menu { top: calc(100% + 6px); bottom: auto; right: 0; left: auto; }
```

再给组件外层加上对应的 class（见 `features/chat/components/ExportMenu.tsx`）。以后顶栏再出现同类菜单，照这个模式加新的作用域规则，别动 `.model-menu` 本身。

另一条同类的公共规则：`shared-components.css` 里

```css
.field input:not([type='range']):not([type='radio']), .field textarea { width: 100%; … }
```

排除了 range 和 radio，**但没排除 checkbox**。`.field` 里放勾选框会被撑成整行、把旁边的文字挤没（模型选择器踩过这个坑）。照样加作用域覆盖压回去（见 `.model-picker-row label input`），不要改这条公共规则。

## 6. 改完必须同步公开仓库

> 2026-09-15 本轮：用户指定 1.2.24，已完成安装包和回归验证，并收到「改源码提交」放行口令，按已指定版本同步提交。源码同步使用 C:/Users/origin/Documents/AI-Chatbot-public。gh 当前未登录，Release 须登录后发布；不要把下方历史版本状态当成当前状态。验证范围及诊断页未完成项见 docs/09-1.2.24排查与优化建议.md。

**先看清节奏：出包 → 用户测 → 用户说「改源码提交」→ 才轮到同步和提交。**
详细分工表在 `origin resource/docs/08-变更记录.md` §2.1，简版：

1. 改源码 → 更新文档 → 升版本 → 打包，**然后停下**。
2. 用户装包实测。这一步之前不要同步公开库、不要 commit、不要 push——
   测出问题就回去接着改，仓库里不留没验证过的提交。
3. 用户说「**改源码提交**」才继续。这里的「改源码」指**同步公开库那份源码副本**，
   不是回头再改开发目录的代码（那在第 1 步就改完了）。
4. 收到这句口令即视为**已授权推送**，两个仓库 commit + push 一气做完，不必再问（§9 的例外）。

这份源码有一个**公开 Git 仓库副本**，它不会自己更新。副本路径**每台机器不一样**，先找到再动手：

| 机器 | 公开库副本路径 |
| --- | --- |
| 本机（Administrator / D 盘仓库） | `D:\Users\Administrator\Documents\GitHub\AI-` |
| 另一台 | `E:\Users\origin\Documents\AI-Chatbot-public` |
| mark_taylor（`e:\Users\origin\AppData\Local\Programs\AI Chatbot`，Win10） | `/c/Users/origin/Documents/AI-Chatbot-public`（1.2.15 时新 clone 的） |

这台机器上 `gh` **没有登录**（`git push` 能过是靠 Windows 凭据管理器，`gh` 读不到它），
发 Release 前要先让用户跑一次 `gh auth login`。

找不到就 `ls -d /*/Users/*/Documents/**/AI-* 2>/dev/null` 扫一遍，或直接
`git clone https://github.com/1731680119/AI-.git`。**注意公开库的目录层级和这里不同**：
它的根目录下直接是 `origin resource/` 和 `source/`，没有中间的 `important resource/`。

> **仓库名的坑**：这个公开库在 GitHub 上显示为「AI-下载」，但**实际 URL 是 `github.com/1731680119/AI-`**——
> GitHub 的仓库名不接受非 ASCII，创建时把「下载」两个字剥掉了。搜中文名找不到，`gh` 命令里也必须写 `AI-`。
>
> 这个库的定位是**源码 + 安装包**：外部用户从它的 Release 下载 `AI-Chatbot-Setup-<版本>.exe`。
> 本目录对应的**私有库是 `1731680119/ai-bot`**，那边额外带着 `user-data/`（聊天记录、API key）。
> **`user-data/` 永远不能进公开库。**

本目录里改完代码、验证过之后，必须：

1. 把改动过的源码拷过去：`origin resource/**`（前端 src、后端 py、docs）、`source/desktop/**`、`source/package.json`。构建产物不要拷——那边 `.gitignore` 已经挡掉 `source/frontend/`、`source/backend/`、`release/`、`electron-dist/`、`node_modules/`、`backend/data/`。
2. 在两边共用的 `origin resource/docs/08-变更记录.md` 顶部加一条记录（格式见该文件 §1），并按改动类型更新 `04`/`06`/`07` 等文档。`docs/` 两边保持逐字一致，改完直接整目录拷过去。
3. `git status` 确认没混进密钥、日志、用户数据，再提交。**推送到 GitHub 前先问用户。**
4. 出了新安装包的话，同时发一个 Release 到该库（这是外部用户唯一的下载入口）：

   ```bat
   gh release create v<版本> ^
     "important resource\source\release\AI-Chatbot-Setup-<版本>.exe" ^
     "important resource\source\release\latest.yml" ^
     --repo 1731680119/AI- --title "v<版本>" --notes "变更说明"
   ```

   **`--repo 1731680119/AI-` 不能省**——在本目录下跑 `gh` 默认会发到私有库 `ai-bot`，那是错的地方。

   **`latest.yml` 也不能省**（1.2.12 起）。自动更新靠它定位新版本，只传 exe 的话所有客户端
   都检测不到更新，而且**不会报任何错**——`autoUpdater` 只是安静地拿到 404。它和 exe 一起
   由 `npm run dist` 产在 `source/release/` 里。细节见 `docs/07-桌面端与打包.md` §6。

漏掉这步不会报错，只会让公开仓库悄悄落后——它曾经停在 1.2.3，而安装包已经发到 1.2.6。
本目录当前版本 1.2.22（已打包、已同步公开库、两个仓库已推送；**Release 待发**——本机 `gh` 未登录，需先跑 `gh auth login`）。
1.2.19 之后按 §3-b 执行：没收到「改源码提交」就一直打同一个版本号，覆盖 `release/` 里的同名包，
收到口令时才升一次再发布。1.2.21 就是这么攒出来的：1.2.17、1.2.18、1.2.19、1.2.20 四个号
**都没单独发过 Release**（1.2.20 升过号也提交进了两个仓库，但那次 Release 卡在 `gh` 未登录上没发出去，
随后又修了 GPT 参数自愈和 DeepSeek 标签栏两处），它们的改动全在 1.2.21 这个包里。
1.2.22 是用户明确说「版本号更新」才升的（§3-b 的例外条款），修的是事件循环被占死
（编辑图片时删不掉记录）、绘画页表单跨页面保留、刚进软件就显示供应商名。
**1.2.21 的 Release 同样卡在 `gh` 未登录上没发出去，所以它也没单独发过包，改动一并在 1.2.22 里。**
Release 已发布的版本：v1.2.3、v1.2.6、v1.2.7。

## 7. 崩溃诊断文件夹（排查问题从这里开始）

软件异常退出（没打开、闪退、启动失败）后，**下次启动会自动**把日志打包成一个文件夹，位置：

```text
%LOCALAPPDATA%\AI Chatbot\data\logs\diagnostics\未处理-YYYY-MM-DD-HHMMSS\
```

（注意是 `LOCALAPPDATA` 不是 `APPDATA`，见 `main.cjs:48` 的 `app.setPath('userData', ...)`。
自从 §10 的 junction 生效后，这个路径实际落在 `<仓库>\user-data\logs\diagnostics\`，
且 `user-data/logs/` 在 `.gitignore` 里，诊断文件夹不会被同步到另一台电脑。）

是文件夹，不是压缩包。里面有 `环境信息.txt`（先看这个：版本、系统、崩溃摘要）、`desktop-fallback.log`、`backend-stdio.log`、`crashes.json`、其它后端日志，以及一份 `说明.md`。

实现在 `source/desktop/diagnostics-archive.cjs`，调用点是 `main.cjs` 的 `promptLastRunCrashed`（先打包再弹窗，用户点忽略也已经存好了）和启动末尾的 `archive.cleanup`。**它刻意不走后端 `/api/diagnostics/bundle`**——闪退时后端多半没起来，走后端等于什么都拿不到，所以直接从 `logDir` 拷文件。改这块时别把这条依赖加回去。

**状态靠文件夹名前缀识别**：`未处理-` / `已处理-`。程序改名（弹窗按钮、设置页）和用户在资源管理器里手动改名都有效。

> **给 AI 的硬性要求**：当你根据某个 `未处理-…` 文件夹里的日志排查并修完问题后，**自己把该文件夹前缀改成「已处理」**（`fs.renameSync` 或 `mv` 都行），不要等用户提醒。

自动清理在每次启动时跑一次（`.last-cleanup` 记日期，同一天不重复扫，不用常驻定时器——闪退频繁时定时器活不到触发）：`已处理` 超 30 天删，`未处理` 超 90 天删。天数按**文件夹名里的时间**算，不看 mtime（拷贝、同步都会改 mtime）。

## 8. 每次对话开始前必须先提问（不用等用户说）

不管用户这次有没有写这句话，**收到任何非平凡的开发任务时，都要先执行下面这条流程**：

> 现在你来向我提问，每次只能提问一个问题，然后根据我的回答来继续提问，以此来对我的需求进行明确与完善。直到你有 95% 以上的把握理解了我的需求以后，说出你的理解，然后当我确认无误后再开始工作。

要点：**一次只问一个问题**，拿到回答后再问下一个；把握到 95% 以上时先复述完整理解，等用户确认「确认／没问题」之后才动手改代码。只有纯查询类（「这个函数在哪」「解释一下这段」）可以跳过。

## 9. 需要先问用户的操作

- 运行 `source/release/` 里的安装包（会覆盖当前已安装版本）。
- 删除或覆盖 `release/` 中的历史安装包。
- 改动根目录的任何运行时文件。
- **对 `user-data/` 的任何删除、清理、重建操作**（那是用户真实的聊天记录，不是缓存）。
- **`git push`**（会把明文 API key 推到远程，且历史删不掉）。
  **唯一例外**：用户说了「改源码提交」这句口令——那就是走 §6 的发布流程，
  同步公开库源码 + 两个仓库 commit + push 一路做完，不用再问。

## 10. `user-data/` 与多机同步（碰这个目录前必读）

完整方案见根目录的 `多机同步说明.md`，这里只列 AI 最容易踩的点。

**① 它不是构建产物，是用户的真实数据。**
`C:\Users\<用户>\AppData\Local\AI Chatbot\data` 是一个**目录联接（junction）**，指向 `<仓库>\user-data`。
应用照常读写老路径，文件实际落在仓库里。所以：

- `user-data/chatbot.db` = 全部聊天记录 + 明文 API key
- `user-data/desktop-settings.json` = API 渠道列表，**里面的 `apiKey` 是明文**（1.2.8 起才在这，见下）
- `user-data/images/`、`uploads/` = 用户的图片和上传附件
- **删掉 = 用户数据没了**，且因为是 junction，从任何一端删都一样

想"清理仓库"时不要顺手带上它。`logs/` 和 `runtime/` 已在 `.gitignore` 里排除，不用再处理。

**同理，也不要对 `%LOCALAPPDATA%\AI Chatbot\data` 用 `rmdir /S /Q` 或 `Remove-Item -Recurse`**——
PowerShell 5.1 的 `Remove-Item -Recurse` 会**穿透 junction 删掉 `user-data/` 里的真实数据**。
需要腾开这个目录时一律用改名（`move` / `Rename-Item ... data.bak`）。
首次部署的完整步骤（cmd / PowerShell 两套写法）见 `多机同步说明.md` §4。

**② 改 `main.cjs` 里 userData 路径的代码要格外小心。**
`app.setPath('userData', ...)`（约 `main.cjs:49`）一旦改动，junction 就失效，用户下次启动会看到一个空的全新数据库——现象是"聊天记录全没了"，但数据其实还在 `user-data/` 里。改这里之前先确认同步方案还成立。

**②-b 只有 `data\` 子目录在同步范围内。**
junction 挂在 `data\` 上，而 userData 设的是它的**父目录**。所以任何"想让它跨机器同步"的文件都必须写到
`path.join(app.getPath('userData'), 'data', ...)`，直接放 userData 根目录等于没同步。
1.2.7 就是把 `desktop-settings.json`（API 渠道列表）放在根目录，导致换台电脑后设置里一个 API 都没有；
1.2.8 用 `migrateSettingsLocation()` 把它挪进了 `data/`，同时把 API Key 从 `safeStorage`（DPAPI，绑机器，
跨机器解不开）改成**明文**。加新的持久化文件时照这个规矩走，别再放根目录。

**③ `.gitattributes` 里 `/user-data/** -text -diff` 不能删。**
仓库全局是 `* text=auto`，一旦对 SQLite 文件生效就会改写字节导致数据库损坏。
后面那条 `/user-data/desktop-settings.json text eol=lf diff` 是给 JSON 开的例外，
**必须排在通配那条之后**才生效，别调换顺序。

**④ 操作 git 前必须确认应用已退出。**
运行中 SQLite 处于 WAL 状态，此时提交的 `chatbot.db` 可能不完整。
`同步-拉取.bat` / `同步-推送.bat` 已内置这个检查——它们用 `findstr` 而不是 `find`，因为在 Git Bash 的 PATH 下 `find` 会解析成 Unix 版本导致检测静默失效。别改回去。

手动检查进程时，**在 PowerShell 里跑**：

```powershell
Get-Process | Where-Object { $_.ProcessName -in 'AI Chatbot','chatbot-backend' }
```

**别用 `tasklist | findstr /I "AI Chatbot.exe chatbot-backend.exe"`**——`findstr` 把空格当 OR，
`AI` 这两个字母会匹配到 M**ai**ntenanceService.exe、nvcont**ai**ner.exe 等无关进程，
看起来像"没退干净"其实早就退了。用 `tasklist` 就必须走 `/FI "IMAGENAME eq ..."` 精确过滤，
且这种带 `/FI` 的命令**不要在 Git Bash 里执行**（会被路径转换成 `E:/Program Files/Git/FI`），
非要用就加 `MSYS_NO_PATHCONV=1` 前缀。详见 `多机同步说明.md` 第 ③ 步。

**⑤ 两台机器同时改了数据库无法合并。**
git 对二进制没有三方合并，只能 `git checkout --ours/--theirs` 二选一，另一边的记录会丢。前提是轮流用。
