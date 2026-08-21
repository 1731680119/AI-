# GUI 检测

对着**真实运行中的桌面应用**做界面检测：连它自己开的 Chrome DevTools 调试端口，
遍历各个界面状态，截图、跑几何断言、和基线做像素对比。

不用 Puppeteer / Playwright——那两个会下载自己的浏览器内核，而我们要测的是
「这个 Electron 版本 + 这份注入脚本」跑出来的真实界面，换个内核测出来的就不算数。
整套零 npm 依赖（像素 diff 借页面自己的 Canvas 做），新机器上不用装任何东西，
也就绕开了 `CLAUDE.md` §4 坑四那个 `npm install` 证书问题。

需要 **Node 22+**（用到全局 `WebSocket` 和 `fetch`）。

## 四档能力

| 档 | 做什么 | 抓什么 |
| --- | --- | --- |
| A 截图巡检 | 每个界面状态各截一张 | 布局错乱、遮挡、空白页 |
| B 几何断言 | 用元素矩形和命中测试做自动判定 | 菜单被遮、勾选框撑爆、文字被压没、横向滚动条 |
| C 视觉回归 | 与本机基线做像素 diff | 「改 A 处样式，B 处悄悄坏了」 |
| D 矩阵 | 3 种分辨率 × 深浅两色各跑一遍 | 响应式断裂、深色模式配色问题 |

## 快速开始

```bash
cd "important resource/origin resource/tools/ui-check"

# 让脚本自己把应用拉起来，跑一遍全部场景
node run.mjs --launch

# 或者：应用已经带调试端口在跑了，直接连
node run.mjs
```

首次运行没有基线，会把这次的截图存成基线并提示「首次运行」。
之后再跑就会给出 diff。跑完命令行会打印报告路径，浏览器打开 `index.html` 就行。

如果要自己启动应用（比如想先手动登录、调状态），启动命令是：

```bash
cd "important resource/source"
unset ELECTRON_RUN_AS_NODE          # 见下面「坑」
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9222
```

## 常用参数

```bash
node run.mjs --list                    # 看有哪些场景
node run.mjs --scene menu-export       # 只跑一个场景，调试规则时用
node run.mjs --matrix                  # 开 D 档矩阵（6 个组合，慢很多）
node run.mjs --update-baseline         # 认可当前界面，把基线刷成这次的样子
node run.mjs --no-diff                 # 只做截图和几何断言，跳过视觉回归
node run.mjs --keep-open               # 跑完不恢复视口和主题，方便接着手动看
```

退出码：几何错误或场景执行失败 → `1`；参数/连接错误 → `2`；其余 `0`。

## 典型工作流

改完 CSS 或组件后：

```bash
node run.mjs                # 看 diff 里有没有意料之外的变化
# 确认变化都是这次想要的 ↓
node run.mjs --update-baseline
```

发版前：

```bash
node run.mjs --matrix       # 全矩阵扫一遍再打包
```

## 几何规则（B 档）

规则都在 `rules.mjs`，每条对应一个**真实踩过的坑**或一类肉眼容易漏的失效。
不加「看起来应该查一下」的泛泛规则——那只会制造噪音，让人开始无视报告。

| 规则 | 级别 | 由来 |
| --- | --- | --- |
| `popup-out-of-viewport` | 错误 | 弹出层跑出视口 = 点不到 |
| `popup-occluded` | 错误 | `CLAUDE.md` §5：`.model-menu` 向上弹被 52px 顶栏遮住。用 `elementFromPoint` 命中测试判定，不去猜顶栏高度和 z-index |
| `checkbox-stretched` | 错误 | `CLAUDE.md` §5：`.field input` 的 `width:100%` 排除了 range/radio 却漏了 checkbox |
| `collapsed-text` | 错误 | 上一条的后果——模型名 `<span>` 被挤成 0 宽，界面上凭空少一段字 |
| `text-clipped` | 提示 | 文字被容器裁掉且没有省略号（带 ellipsis 的是设计意图，不报） |
| `page-h-scroll` | 错误 | 整页出现横向滚动，响应式坏掉最典型的信号；会一并列出把页面撑宽的元素 |
| `control-offscreen` | 错误 | 可交互控件整个落在视口外（在滚动容器里的不算） |

加规则就往 `rules.mjs` 的 `out` 里 push，字段是 `{ rule, severity, selector, message }`。

## 场景（A/C/D 档遍历的对象）

场景定义在 `scenes.mjs`。

> **硬性约束：所有场景必须只读。**
> 这套检测是对着真实 `user-data/` 跑的（用户的聊天记录和明文 API Key，见 `CLAUDE.md` §10），
> 绝不能新建对话、发消息、保存设置或删任何东西。所以场景里只有「打开 / 切换 / 展开」，
> 没有「提交」。加新场景时守住这条。

步骤 DSL：

```js
{ click: '选择器', optional: true }   // 真实鼠标点击（走命中测试，被遮住会失败——这是特性）
{ clickText: ['选择器', '文字'] }      // 按可见文字点，用于设置左侧导航那种没有稳定 class 的
{ type: ['选择器', '文字'] }           // 真实键盘输入
{ key: 'Escape' }
{ eval: 'JS 表达式' }
{ waitFor: '选择器' }
{ wait: 300 }
```

场景可以带 `skipIf`（表达式为真就跳过，比如没有历史对话时不测导出菜单），
跳过不算失败。

## 抓不到的东西

**Electron 主进程的原生 UI 全部在射程之外**：窗口菜单栏、`dialog.showErrorBox`、
托盘、系统通知、NSIS 安装界面。这些不在渲染进程里，CDP 看不见。
比如「后端已停止」那个错误框、崩溃后的诊断弹窗（`CLAUDE.md` §7），都只能靠代码审查
或 Windows 层面截屏来验证。

## 坑

**`ELECTRON_RUN_AS_NODE`**（`CLAUDE.md` §4 坑一）
VSCode 扩展宿主会把它传下来，一存在 `electron.exe` 就退化成普通 Node，窗口压根不出现。
**设成空字符串无效，必须彻底 `unset`。** `--launch` 已经在代码里 `delete` 掉了。

**别用 `electron-dist/` 里那份 electron**（§4 坑三）
那是改过名的精简发行版，没有 `default_app.asar`，跑不起来。只能用
`source/node_modules/electron/dist/electron.exe`。

**基线不能跨机器共用**
字体渲染、DPI、显卡抗锯齿都会让像素对不上，拿别的机器的基线跑出来全是假差异。
所以 `baseline/` 和 `report/` 都在 `.gitignore` 里，换机器重新 `--update-baseline` 建一份。

**应用可能卡在原生崩溃提示弹窗上**
上次异常退出后，启动时会先弹一个原生对话框（§7）。那是模态的，会让 CDP 连接一直等。
连不上先看看是不是有个弹窗在等你点。

**点击走的是真实命中测试**
用的是 `Input.dispatchMouseEvent` 而不是 `el.click()`。后者绕过命中测试，
元素被别的层挡住时照样"点得到"——而"被挡住"恰恰是 GUI 检测最该发现的问题。
所以某个 `click` 步骤失败时，先怀疑是真的被遮住了，别急着改选择器。
