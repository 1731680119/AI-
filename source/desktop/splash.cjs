/**
 * 启动画面（splash）。
 *
 * 存在的理由：`startBackend()` 要等 PyInstaller 单文件后端解包 + 被 Defender
 * 扫完，冷启动几十秒是常态。在这之前主窗口还没创建，用户双击图标后**屏幕上
 * 什么都没有**，很容易以为没启动成功而反复双击。
 *
 * 几条刻意的设计：
 *
 * - **不走后端**。它必须在后端就绪之前就显示，所以只 `loadFile` 一个本地
 *   html，不依赖 `backendUrl`，也不注入 page-enhancements。
 * - **所有方法都吞异常**。启动画面是锦上添花，它自己出问题绝不能把启动流程
 *   带崩——`close()` 尤其要保证一定执行到，否则会留下一个关不掉的无边框窗口。
 * - **状态文字用 executeJavaScript 推**，不额外开 IPC/preload：这个窗口加载
 *   的是我们自己写死的本地文件，没有第三方内容，没必要为它铺一套通道。
 */
const { BrowserWindow, app } = require('electron')
const path = require('node:path')

let splash = null
/** 关掉之后如果还有迟到的 setStatus 调用，直接忽略。 */
let closed = false

function create() {
  if (splash || closed) return null
  try {
    splash = new BrowserWindow({
      width: 420,
      height: 240,
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      center: true,
      title: 'AI Chatbot',
      icon: path.join(__dirname, 'assets', 'icon.ico'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 无边框窗口没有菜单，禁掉开发者工具的快捷键，免得误触。
        devTools: false,
      },
    })
    splash.once('ready-to-show', () => {
      if (!closed) splash?.show()
    })
    splash.on('closed', () => { splash = null })
    void splash.loadFile(path.join(__dirname, 'splash.html'))
    splash.webContents.once('did-finish-load', () => {
      run(`window.setSplashVersion(${JSON.stringify(app.getVersion())})`)
    })
    return splash
  } catch (error) {
    // 起不来就当没有启动画面，不影响主流程。
    splash = null
    return null
  }
}

function run(script) {
  if (!splash || splash.isDestroyed()) return
  try {
    void splash.webContents.executeJavaScript(script).catch(() => {})
  } catch {
    /* 页面还没加载完或已销毁，忽略 */
  }
}

/**
 * 更新底部那行小字。`note` 是可选的第二行，用来解释「为什么这一步这么慢」。
 */
function setStatus(text, note) {
  if (closed) return
  run(`window.setSplashStatus && window.setSplashStatus(${JSON.stringify(text ?? '')}, ${JSON.stringify(note ?? '')})`)
}

/**
 * 关闭启动画面。
 *
 * 幂等，且**必须**在主窗口 `show()` 之后调用——反过来会让桌面在两者之间
 * 空一帧，看着像闪了一下。
 */
function close() {
  closed = true
  const target = splash
  splash = null
  if (!target || target.isDestroyed()) return
  try {
    target.destroy()
  } catch {
    /* 已经没了 */
  }
}

module.exports = { create, setStatus, close }
