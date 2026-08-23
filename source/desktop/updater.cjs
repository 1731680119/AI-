/**
 * 自动更新：检查 GitHub 公开库 1731680119/AI- 的 Release，下载并安装新版安装包。
 *
 * 几条刻意的设计：
 *
 * - **不自动下载**（`autoDownload = false`）。安装包上百 MB，启动就偷跑流量不合适。
 *   主进程只负责查出「有没有新版」，下不下载由界面上的按钮说了算。
 * - **不弹系统对话框**。状态一律通过 `desktop:update-state` 推给渲染进程，
 *   由设置里的「关于与更新」那一栏显示，侧边栏设置按钮上只出现一个小红点。
 * - **不静默安装**。打包用的是非一键 NSIS（`oneClick: false`，允许自定义安装路径），
 *   静默安装会忽略用户当初选的目录，可能装出第二份。所以 `quitAndInstall` 传
 *   `isSilent = false`，老老实实走安装向导。
 * - **未打包时整体停用**。开发态没有 app-update.yml，electron-updater 会直接抛错，
 *   这里提前挡掉，界面上显示成「开发模式不检查更新」。
 */
const { app, ipcMain } = require('electron')

const diag = require('./diagnostics-logger.cjs')

/** 启动后延迟多久做第一次检查。等窗口和后端都起来了再查，别抢启动那几秒。 */
const FIRST_CHECK_DELAY_MS = 8000

/**
 * 渲染进程看到的完整状态。`status` 的取值：
 * idle / checking / available / not-available / downloading / downloaded / error / disabled
 */
let state = {
  status: 'idle',
  currentVersion: '',
  version: '',
  releaseNotes: '',
  releaseDate: '',
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  error: '',
  checkedAt: 0,
}

let autoUpdater = null
let broadcast = () => {}

function setState(patch) {
  state = { ...state, ...patch }
  broadcast(publicState())
}

function publicState() {
  return { ...state, currentVersion: app.getVersion() }
}

/** electron-updater 给的 releaseNotes 可能是字符串，也可能是 {version, note} 数组。 */
function normalizeNotes(notes) {
  if (!notes) return ''
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes
      .map((item) => (typeof item === 'string' ? item : `## ${item.version}\n${item.note ?? ''}`))
      .join('\n\n')
  }
  return ''
}

function attach() {
  const updater = autoUpdater
  updater.autoDownload = false
  // 我们自己控制安装时机；留着这个开关会在用户正常退出时偷偷装上。
  updater.autoInstallOnAppQuit = false
  updater.logger = {
    info: (message) => diag.info('update', String(message)),
    warn: (message) => diag.warn('update', String(message)),
    error: (message) => diag.error('update', String(message)),
    debug: () => {},
  }

  updater.on('checking-for-update', () => setState({ status: 'checking', error: '' }))
  updater.on('update-available', (info) => {
    diag.info('update', '发现新版本', { version: info?.version })
    setState({
      status: 'available',
      version: info?.version ?? '',
      releaseNotes: normalizeNotes(info?.releaseNotes),
      releaseDate: info?.releaseDate ?? '',
      percent: 0,
      error: '',
      checkedAt: Date.now(),
    })
  })
  updater.on('update-not-available', () => {
    setState({ status: 'not-available', version: '', error: '', checkedAt: Date.now() })
  })
  updater.on('download-progress', (progress) => {
    setState({
      status: 'downloading',
      percent: Math.round(progress?.percent ?? 0),
      transferred: progress?.transferred ?? 0,
      total: progress?.total ?? 0,
      bytesPerSecond: progress?.bytesPerSecond ?? 0,
    })
  })
  updater.on('update-downloaded', (info) => {
    diag.info('update', '新版本已下载完成', { version: info?.version })
    setState({ status: 'downloaded', percent: 100, version: info?.version ?? state.version })
  })
  updater.on('error', (error) => {
    const message = error?.message ?? String(error)
    diag.error('update', `更新失败：${message}`)
    setState({ status: 'error', error: message })
  })
}

/**
 * 初始化。`sendToAll` 用来把状态广播给所有窗口。
 * 返回值只是方便调用方判断有没有真的启用。
 */
function init(sendToAll) {
  broadcast = typeof sendToAll === 'function' ? sendToAll : () => {}

  if (!app.isPackaged) {
    state = { ...state, status: 'disabled', error: '开发模式（未打包）不检查更新' }
    diag.info('update', '未打包，跳过自动更新')
    return false
  }

  try {
    // require 放在这里而不是文件顶部：万一依赖缺失，也只是更新功能不可用，
    // 不至于让整个主进程在加载阶段就崩掉。
    autoUpdater = require('electron-updater').autoUpdater
  } catch (error) {
    state = { ...state, status: 'disabled', error: `更新组件不可用：${error.message}` }
    diag.error('update', `加载 electron-updater 失败：${error.message}`)
    return false
  }

  attach()
  setTimeout(() => { void check(false) }, FIRST_CHECK_DELAY_MS)
  return true
}

/** 检查更新。manual=true 是用户在设置里点的，会把错误如实报出来。 */
async function check(manual = true) {
  if (!autoUpdater) return publicState()
  if (state.status === 'downloading' || state.status === 'downloaded') return publicState()
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    // 静默检查失败（断网、GitHub 不通）不该在界面上留一条红字，记日志就够了。
    if (manual) setState({ status: 'error', error: error.message })
    else diag.warn('update', `后台检查更新失败：${error.message}`)
  }
  return publicState()
}

async function download() {
  if (!autoUpdater) return publicState()
  if (state.status !== 'available' && state.status !== 'error') return publicState()
  setState({ status: 'downloading', percent: 0, error: '' })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    setState({ status: 'error', error: error.message })
  }
  return publicState()
}

/**
 * 退出并安装。
 *
 * `beforeQuit` 由 main.cjs 传进来，负责停后端、写「干净退出」标记——
 * 少了这一步，下次启动会把这次更新误判成崩溃，弹一个莫名其妙的诊断提示。
 */
function quitAndInstall(beforeQuit) {
  if (!autoUpdater || state.status !== 'downloaded') return false
  diag.info('update', '准备退出并安装新版本', { version: state.version })
  try {
    if (typeof beforeQuit === 'function') beforeQuit()
  } catch (error) {
    diag.error('update', `安装前清理失败：${error.message}`)
  }
  // isSilent=false：走完整安装向导，保住用户自定义的安装目录。
  // isForceRunAfter=true：装完自动把应用拉起来。
  autoUpdater.quitAndInstall(false, true)
  return true
}

function registerIpc({ beforeQuit }) {
  ipcMain.handle('desktop:update-state', () => publicState())
  ipcMain.handle('desktop:update-check', () => check(true))
  ipcMain.handle('desktop:update-download', () => download())
  ipcMain.handle('desktop:update-install', () => quitAndInstall(beforeQuit))
}

module.exports = { init, check, download, quitAndInstall, registerIpc, publicState }
