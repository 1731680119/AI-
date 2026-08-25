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
 * - **只在启动时自动查一次**，之后一律等用户点「检查更新」。没有周期性定时器：
 *   这个软件是长时间挂着用的，定时轮询除了偶尔弹个红点没别的用处。
 * - **连不上就自动降级**。GitHub 在国内经常直连不通，`net-fallback.cjs` 会依次
 *   试 DoH 解析、镜像站、HTTP 代理。它的所有改动都只在本进程内存里，
 *   **不碰系统 hosts / 不装驱动 / 不改系统代理**，进程一死就没了，
 *   不存在「没关软件就关机导致下次开机断网」这类残留风险。
 *   即便如此每轮结束仍会 `teardown()` 主动还原，避免影响更新之外的请求。
 */
const { app, ipcMain } = require('electron')

const diag = require('./diagnostics-logger.cjs')
const netFallback = require('./net-fallback.cjs')

/**
 * 启动时那次自动检查延迟多久。
 *
 * 主窗口 show 出来之后再查：检查本身要发网络请求，可能还要跑一轮降级探测，
 * 抢在启动那几秒里做只会让界面更晚出来。
 */
const FIRST_CHECK_DELAY_MS = 8000

/** electron-updater 的 generic provider 直连地址（GitHub Release 的固定路径）。 */
const DIRECT_FEED = 'https://github.com/1731680119/AI-/releases/latest/download'

/**
 * 镜像候选。都是把 GitHub 原始 URL 拼在后面的反代，顺序即优先级。
 * 这类站点时好时坏，多留几个，`establish()` 会逐个探活。
 */
const MIRROR_FEEDS = [
  `https://ghfast.top/${DIRECT_FEED}`,
  `https://gh-proxy.com/${DIRECT_FEED}`,
  `https://ghproxy.net/${DIRECT_FEED}`,
]

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
  /** 本次是走哪条通道通的：直连 / DoH 解析直连 / 镜像 xxx / 系统代理 xxx。 */
  channel: '',
}

let autoUpdater = null
let broadcast = () => {}
/** 读取用户配置的更新代理地址，由 main.cjs 注入。 */
let readProxy = () => ''
/** 启动那次自动检查是否已经跑过。跑过之后就只认手动触发。 */
let autoCheckDone = false

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
 * 初始化。`sendToAll` 用来把状态广播给所有窗口，
 * `getProxy` 返回用户在设置里填的更新代理地址（可为空）。
 * 返回值只是方便调用方判断有没有真的启用。
 */
function init(sendToAll, getProxy) {
  broadcast = typeof sendToAll === 'function' ? sendToAll : () => {}
  readProxy = typeof getProxy === 'function' ? getProxy : () => ''

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
  // 全程只有这一次自动检查，之后完全由用户点按钮驱动。
  setTimeout(() => { void check(false) }, FIRST_CHECK_DELAY_MS)
  return true
}

/**
 * 建立可用的更新通道，并把 electron-updater 的 feed 指过去。
 *
 * 每次 check/download 前都要跑一遍：网络环境会变（连上 VPN、代理关了），
 * 缓存上一次的结论只会在环境变化后给出莫名其妙的失败。
 */
async function openChannel() {
  const channel = await netFallback.establish({
    directBase: DIRECT_FEED,
    mirrorBases: MIRROR_FEEDS,
    manualProxy: readProxy(),
  })
  // generic provider：直接按 base + latest.yml 找版本，
  // 这样镜像地址才能原样用上（github provider 会自己拼 api.github.com）。
  autoUpdater.setFeedURL({ provider: 'generic', url: channel.base })
  return channel
}

/**
 * 检查更新。`manual=true` 是用户在设置里点的，会把错误如实报出来。
 *
 * 启动时那一次走 `manual=false`；此后**没有任何自动触发**，
 * 想再查只能靠界面上的按钮。
 */
async function check(manual = true) {
  if (!autoUpdater) return publicState()
  if (state.status === 'downloading' || state.status === 'downloaded') return publicState()
  if (!manual) {
    // 防御性的：启动那次只该跑一遍，重复调用直接忽略。
    if (autoCheckDone) return publicState()
    autoCheckDone = true
  }
  setState({ status: 'checking', error: '', channel: '' })
  try {
    const channel = await openChannel()
    setState({ channel: channel.description })
    await autoUpdater.checkForUpdates()
  } catch (error) {
    // 静默检查失败（断网、GitHub 不通）不该在界面上留一条红字，记日志就够了。
    if (manual) setState({ status: 'error', error: error.message })
    else {
      diag.warn('update', `后台检查更新失败：${error.message}`)
      setState({ status: 'idle', error: '' })
    }
  } finally {
    // 检查阶段用完就还原：不能让 DoH lookup / 代理 Agent 影响到别的请求。
    // 下载会重新建一次通道。
    netFallback.teardown()
  }
  return publicState()
}

async function download() {
  if (!autoUpdater) return publicState()
  if (state.status !== 'available' && state.status !== 'error') return publicState()
  setState({ status: 'downloading', percent: 0, error: '' })
  try {
    const channel = await openChannel()
    setState({ channel: channel.description })
    await autoUpdater.downloadUpdate()
  } catch (error) {
    setState({ status: 'error', error: error.message })
  } finally {
    // 下载完就把降级设置撤掉——这是「下载完成后关闭代理」那一步。
    netFallback.teardown()
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
  // 保险起见再还原一次：download 的 finally 已经做过，但这里是进程的最后一站。
  netFallback.teardown()
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
