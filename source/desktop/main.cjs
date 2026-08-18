const {
  app,
  BrowserWindow,
  WebContentsView,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  // safeStorage 只在 migrateSettingsLocation 里用一次：把旧版 DPAPI 密文解回明文。
  safeStorage,
  shell,
  Tray,
} = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const diag = require('./diagnostics-logger.cjs')
const archive = require('./diagnostics-archive.cjs')

const APP_NAME = 'AI Chatbot'
const CLOSE_DELAY_MS = 5000
const DEEPSEEK_TAB_HEIGHT = 42
const VALID_CLOSE_PREFERENCES = new Set(['ask', 'close', 'tray'])
const iconPath = path.join(__dirname, 'assets', 'icon.ico')
const pageEnhancementsPath = path.join(__dirname, 'page-enhancements.js')
const enhancementsCssPath = path.join(__dirname, 'enhancements.css')

const DEFAULT_ENHANCEMENTS = {
  apiList: [],
  apiTimeoutSeconds: 15,
  deepseekUrl: 'https://chat.deepseek.com/',
  prompts: {
    ask: '解释一下“{content}”',
    explainCode: '解释以下代码：\n\n{content}',
    findIssues: '检查以下代码并找出问题：\n\n{content}',
    optimizeCode: '优化以下代码，并说明优化内容：\n\n{content}',
  },
  modelApiMap: {},
  legacyApiMigrated: false,
}

if (process.env.LOCALAPPDATA) {
  app.setPath('userData', path.join(process.env.LOCALAPPDATA, APP_NAME))
}
app.setName(APP_NAME)

// 与后端 paths.py 的 LOG_DIR 保持同一个目录，导出诊断包时三层日志才会齐全。
diag.init({
  logDir: path.join(app.getPath('userData'), 'data', 'logs'),
  backendUrl: () => backendUrl,
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

let backendProcess = null
let backendLogStream = null
let backendUrl = ''
let isQuitting = false
let shutdownTimer = null
let closePreference = 'ask'
let enhancements = structuredClone(DEFAULT_ENHANCEMENTS)
let apiLockTail = Promise.resolve()
// 后端 stderr 的最后若干行。后端异常退出时随崩溃记录一起写下，
// 否则只有一个退出码，看不出死因。
const backendStderrTail = []
const windows = new Map()
const allowedToClose = new Set()
const apiAttemptLocks = new Map()

// 桌面设置放在 userData/data/ 而不是 userData/ 根目录：
// data/ 是多机同步 junction 的挂载点（指向仓库 user-data/），放根目录就同步不到。
function settingsPath() {
  return path.join(app.getPath('userData'), 'data', 'desktop-settings.json')
}

// 1.2.7 及更早版本的位置。只在 migrateSettingsLocation 里读一次。
function legacySettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json')
}

const STDERR_TAIL_LINES = 40

function appendStderrTail(chunk) {
  const text = String(chunk)
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    backendStderrTail.push(line)
  }
  while (backendStderrTail.length > STDERR_TAIL_LINES) backendStderrTail.shift()
}

/** 崩溃统一入口：同步落盘，再尽力交给后端，最后才让进程继续死。 */
function reportCrash(kind, message, detail, fields) {
  diag.record('CRITICAL', 'crash', `${kind}：${message}`, fields, { sync: true })
  diag.recordCrash(kind, message, detail)
  diag.flushSync()
}

process.on('uncaughtException', (error) => {
  reportCrash('uncaughtException', error?.message ?? String(error), error?.stack ?? '')
})

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : null
  reportCrash(
    'unhandledRejection',
    error?.message ?? String(reason),
    error?.stack ?? '',
  )
})

function normalizeEnhancements(value = {}) {
  const prompts = { ...DEFAULT_ENHANCEMENTS.prompts, ...(value.prompts || {}) }
  return {
    ...DEFAULT_ENHANCEMENTS,
    ...value,
    apiList: Array.isArray(value.apiList) ? value.apiList : [],
    apiTimeoutSeconds: Math.min(120, Math.max(3, Number(value.apiTimeoutSeconds) || 15)),
    prompts,
    modelApiMap: value.modelApiMap && typeof value.modelApiMap === 'object' ? value.modelApiMap : {},
  }
}

function loadDesktopSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    if (VALID_CLOSE_PREFERENCES.has(settings.closePreference)) closePreference = settings.closePreference
    enhancements = normalizeEnhancements(settings.enhancements)
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('读取桌面设置失败', error)
  }
}

function saveDesktopSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(
    settingsPath(),
    JSON.stringify({ closePreference, enhancements }, null, 2),
    'utf8',
  )
}

/**
 * 把 1.2.7 及更早版本的 desktop-settings.json 迁到 data/ 下，并把 API Key 从
 * safeStorage 密文还原成明文。
 *
 * 旧版用 safeStorage 加密 Key，Windows 上走 DPAPI——密文绑定当前用户+当前机器，
 * 换台电脑解不开。多机同步要让 Key 跟着走，就只能存明文（绘图 API 的 Key 本来
 * 也是明文存在 chatbot.db 里的，这里只是对齐）。
 *
 * 触发条件不能简单写成"新文件不存在"：多机同步下，先升级的那台会把一份**空的**
 * 新配置推到仓库，另一台拉下来后新文件已存在，真正存着 Key 的旧文件就永远迁不动了。
 * 所以只要新配置的 apiList 是空的、而旧文件里有内容，就照样迁。
 *
 * 必须在 loadDesktopSettings 之前跑，否则读到的是空配置。
 */
function migrateSettingsLocation() {
  const target = settingsPath()
  const legacy = legacySettingsPath()
  if (!fs.existsSync(legacy)) return
  try {
    const settings = JSON.parse(fs.readFileSync(legacy, 'utf8'))
    const apiList = Array.isArray(settings?.enhancements?.apiList)
      ? settings.enhancements.apiList
      : []
    if (fs.existsSync(target) && !shouldOverwriteWithLegacy(target, apiList)) return
    if (!settings.enhancements) settings.enhancements = {}
    settings.enhancements.apiList = apiList.map(({ encryptedKey, ...item }) => ({
      ...item,
      // 解不开就留空，用户重填一次即可，不要因为一条坏数据中断整个迁移。
      apiKey: item.apiKey || decryptLegacyApiKey(encryptedKey),
    }))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(settings, null, 2), 'utf8')
    // 旧文件留作备份，不直接删——迁移出错时还能人工找回。
    fs.renameSync(legacy, `${legacy}.bak`)
    diag.info('settings', '桌面设置已迁移到 data/ 目录', { apiCount: apiList.length })
  } catch (error) {
    console.error('迁移桌面设置失败', error)
    diag.error('settings', '迁移桌面设置失败', { message: error.message })
  }
}

/** 新配置已存在时，只有它没有任何 API、而旧文件有，才值得覆盖。 */
function shouldOverwriteWithLegacy(target, legacyApiList) {
  if (!legacyApiList.length) return false
  try {
    const current = JSON.parse(fs.readFileSync(target, 'utf8'))
    return !(current?.enhancements?.apiList || []).length
  } catch {
    // 新文件读不出来（损坏/半截），用旧的覆盖反而更安全。
    return true
  }
}

function decryptLegacyApiKey(value) {
  if (!value) return ''
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch (error) {
    console.error('解密旧版 API Key 失败', error)
    return ''
  }
}

function publicEnhancementSettings() {
  const apiNames = new Map(enhancements.apiList.map((item) => [item.id, item.name]))
  return {
    // 这里的解构是把明文 apiKey 从返回值里剔掉——渲染进程只该拿到 hasKey，
    // 真要看明文得走 desktop:reveal-api-key。改这行前先想清楚。
    apiList: enhancements.apiList.map(({ apiKey, ...item }) => ({
      ...item,
      hasKey: Boolean(apiKey),
    })),
    apiTimeoutSeconds: enhancements.apiTimeoutSeconds,
    deepseekUrl: enhancements.deepseekUrl,
    prompts: enhancements.prompts,
    modelMatches: Object.fromEntries(
      Object.entries(enhancements.modelApiMap)
        .filter(([, apiId]) => apiNames.has(apiId))
        .map(([model, apiId]) => [model, { apiId, apiName: apiNames.get(apiId) }]),
    ),
  }
}

function apiFingerprint(apiList) {
  return JSON.stringify(apiList.map((item) => ({
    id: item.id,
    name: item.name,
    baseUrl: item.baseUrl,
    enabled: item.enabled,
    apiKey: item.apiKey,
  })))
}

function normalizeBaseUrl(value) {
  const parsed = new URL(String(value || '').trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('API URL 必须使用 http 或 https')
  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = parsed.pathname.replace(/\/chat\/completions$/i, '') || '/'
  return parsed.toString().replace(/\/$/, '')
}

function normalizeWebUrl(value) {
  const parsed = new URL(String(value || '').trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('DeepSeek 网页地址必须使用 http 或 https')
  return parsed.toString()
}

function saveEnhancementSettings(payload) {
  const existing = new Map(enhancements.apiList.map((item) => [item.id, item]))
  const seen = new Set()
  const apiList = (payload.apiList || []).map((raw, index) => {
    const id = raw.id && !seen.has(raw.id) ? raw.id : crypto.randomUUID()
    seen.add(id)
    const previous = existing.get(id)
    const name = String(raw.name || '').trim() || `API ${index + 1}`
    const baseUrl = normalizeBaseUrl(raw.baseUrl)
    // 前端只在用户改动时才带上 apiKey，没带就沿用已存的那份。
    const apiKey = raw.apiKey ? String(raw.apiKey) : previous?.apiKey || ''
    return { id, name, baseUrl, apiKey, enabled: raw.enabled !== false }
  })

  const previousFingerprint = apiFingerprint(enhancements.apiList)
  enhancements.apiList = apiList
  enhancements.apiTimeoutSeconds = Math.min(120, Math.max(3, Number(payload.apiTimeoutSeconds) || 15))
  enhancements.deepseekUrl = normalizeWebUrl(payload.deepseekUrl || DEFAULT_ENHANCEMENTS.deepseekUrl)
  enhancements.prompts = {
    ...DEFAULT_ENHANCEMENTS.prompts,
    ...(payload.prompts || {}),
  }
  if (previousFingerprint !== apiFingerprint(apiList)) {
    enhancements.modelApiMap = {}
  }
  saveDesktopSettings()
  return publicEnhancementSettings()
}

function requestBackend(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, backendUrl)
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const request = http.request(target, {
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      } : undefined,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data = null
        try { data = text ? JSON.parse(text) : null } catch { data = text }
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(data?.detail || data?.message || `后端请求失败 (${response.statusCode})`))
        } else {
          resolve(data)
        }
      })
    })
    request.setTimeout(10000, () => request.destroy(new Error('本地后端请求超时')))
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

async function migrateLegacyApiSettings() {
  if (enhancements.legacyApiMigrated) return
  try {
    const legacy = await requestBackend('GET', '/api/settings')
    if (legacy?.base_url || legacy?.api_key) {
      enhancements.apiList.push({
        id: crypto.randomUUID(),
        name: '原有 API',
        baseUrl: normalizeBaseUrl(legacy.base_url || 'http://127.0.0.1/v1'),
        apiKey: legacy.api_key || '',
        enabled: true,
      })
    }
    enhancements.legacyApiMigrated = true
    enhancements.modelApiMap = {}
    saveDesktopSettings()
    await requestBackend('PUT', '/api/settings', { base_url: '', api_key: '' })
  } catch (error) {
    console.error('迁移旧 API 设置失败', error)
  }
}

function migrateLegacyData() {
  const destination = path.join(app.getPath('userData'), 'data')
  if (fs.existsSync(path.join(destination, 'chatbot.db'))) return
  const candidates = [
    process.env.CHATBOT_LEGACY_DATA_DIR,
    path.join(os.homedir(), 'Desktop', 'chatbot', 'chatbot-web', 'backend', 'data'),
    path.join(os.homedir(), 'Desktop', 'chatbot-web', 'backend', 'data'),
    path.resolve(__dirname, '..', 'backend', 'data'),
  ].filter(Boolean)
  const source = candidates.find((candidate) => {
    try {
      return path.resolve(candidate) !== path.resolve(destination)
        && fs.existsSync(path.join(candidate, 'chatbot.db'))
    } catch {
      return false
    }
  })
  if (!source) return
  fs.mkdirSync(destination, { recursive: true })
  fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: false })
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

/**
 * 等后端把 /api/health 支起来。
 *
 * 后端是 PyInstaller 单文件 exe，第一次跑（尤其是刚升级完）要先把几十 MB
 * 解到临时目录，还会被 Defender 整个扫一遍，冷启动几十秒很正常——原来固定
 * 30 秒的上限就是这么被打穿的（启动失败后手动再开一次反而秒起）。
 * 所以这里不再单纯看时间：只要后端进程还活着就继续等，硬上限放到 5 分钟
 * 兜底；进程要是已经退了，就不必再空等，exit 回调那边会报真正的原因。
 */
function waitForBackend(url, timeoutMs = 300000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  let notified = false
  return new Promise((resolve, reject) => {
    const retry = () => {
      // 进程没了就别等了，等到超时只会把真实死因盖成「超时」。
      if (!backendProcess) return reject(new Error('本地后端进程已退出，未能启动'))
      const waited = Date.now() - started
      if (waited >= timeoutMs || Date.now() >= deadline) {
        return reject(new Error(`等待本地后端启动超时（已等 ${Math.round(waited / 1000)} 秒）`))
      }
      // 超过 20 秒还没起来，多半在解包或被杀毒软件扫，留一条日志方便回溯。
      if (!notified && waited > 20000) {
        notified = true
        diag.warn('backend', '后端启动较慢，仍在等待', { waitedMs: waited, url })
      }
      setTimeout(check, 200)
    }
    const check = () => {
      const request = http.get(`${url}/api/health`, (response) => {
        response.resume()
        if (response.statusCode === 200) {
          if (notified) diag.info('backend', '后端最终启动成功', { waitedMs: Date.now() - started })
          return resolve()
        }
        retry()
      })
      request.setTimeout(1000, () => request.destroy())
      request.on('error', retry)
    }
    check()
  })
}

async function startBackend() {
  const port = await reservePort()
  const dataDir = path.join(app.getPath('userData'), 'data')
  const frontendDir = app.isPackaged
    ? path.join(process.resourcesPath, 'frontend')
    : path.resolve(__dirname, '..', 'frontend')
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'backend', 'chatbot-backend.exe')
    : path.resolve(__dirname, '..', 'backend', 'chatbot-backend.exe')
  const logDir = diag.paths().logDir
  fs.mkdirSync(logDir, { recursive: true })
  // 后端自己写结构化日志，这里只留一份原始 stdout/stderr，便于排查启动阶段的问题。
  backendLogStream = fs.createWriteStream(path.join(logDir, 'backend-stdio.log'), { flags: 'a' })
  diag.info('backend', '启动本地后端', {
    executable, port, dataDir, packaged: app.isPackaged,
  })
  backendProcess = spawn(executable, ['--port', String(port)], {
    cwd: path.dirname(executable),
    windowsHide: true,
    env: {
      ...process.env,
      CHATBOT_DATA_DIR: dataDir,
      CHATBOT_FRONTEND_DIST: frontendDir,
      CHATBOT_APP_VERSION: app.getVersion(),
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backendProcess.stdout.pipe(backendLogStream, { end: false })
  backendProcess.stderr.pipe(backendLogStream, { end: false })
  backendProcess.stderr.on('data', appendStderrTail)
  backendProcess.on('error', (error) => {
    reportCrash('backendSpawnFailed', error.message, error.stack ?? '', { executable })
  })
  backendProcess.once('exit', (code, signal) => {
    backendProcess = null
    if (isQuitting) {
      diag.info('backend', '后端随应用退出', { code, signal })
      return
    }
    const tail = backendStderrTail.join('\n')
    reportCrash(
      'backendExit',
      `本地后端意外退出（代码 ${code ?? '未知'}）`,
      tail,
      { code, signal },
    )
    // 后端已经死了，日志发不出去，只能靠上面的同步兜底写入。
    dialog.showErrorBox(
      '后端已停止',
      `本地后端意外退出（代码 ${code ?? '未知'}）。请重新启动软件。\n\n日志目录：${diag.paths().logDir}`,
    )
    exitApplication(false)
  })
  backendUrl = `http://127.0.0.1:${port}`
  await waitForBackend(backendUrl)
  diag.info('backend', '本地后端已就绪', { url: backendUrl })
}

function stopBackend() {
  if (backendProcess) {
    const pid = backendProcess.pid
    backendProcess.removeAllListeners('exit')
    if (process.platform === 'win32' && pid) {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      backendProcess.kill()
    }
    backendProcess = null
  }
  backendLogStream?.end()
  backendLogStream = null
}

function cancelScheduledShutdown() {
  if (shutdownTimer) clearTimeout(shutdownTimer)
  shutdownTimer = null
}

function scheduleShutdownIfEmpty() {
  if (windows.size !== 0 || isQuitting) return
  cancelScheduledShutdown()
  shutdownTimer = setTimeout(exitApplication, CLOSE_DELAY_MS)
}

/** clean=false 用于崩溃退出：不写干净退出标记，下次启动才会提示。 */
function exitApplication(clean = true) {
  if (isQuitting) return
  isQuitting = true
  cancelScheduledShutdown()
  for (const record of windows.values()) {
    record.tray?.destroy()
    for (const tab of record.deepseekTabs.values()) tab.view.webContents.close()
  }
  stopBackend()
  diag.info('lifecycle', clean ? '应用退出' : '应用异常退出')
  // app.exit 不会触发 before-quit，标记与排空必须在这里做一次。
  if (clean) diag.markCleanExit()
  diag.flushSync()
  app.exit(0)
}

function destroyWindowTray(id) {
  const record = windows.get(id)
  if (!record?.tray) return
  record.tray.destroy()
  record.tray = null
}

function closeWindowWithoutPrompt(window) {
  if (!window || window.isDestroyed()) return
  allowedToClose.add(window.id)
  destroyWindowTray(window.id)
  window.close()
}

function restoreWindow(window) {
  if (!window || window.isDestroyed()) return
  destroyWindowTray(window.id)
  window.show()
  window.restore()
  window.focus()
}

function minimizeWindowToTray(window) {
  if (!window || window.isDestroyed()) return
  const record = windows.get(window.id)
  if (!record) return
  window.hide()
  if (record.tray) return
  const tray = new Tray(iconPath)
  tray.setToolTip(window.getTitle() || APP_NAME)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '恢复窗口', click: () => restoreWindow(window) },
    { label: '新建窗口', click: () => createWindow() },
    { type: 'separator' },
    { label: '关闭此聊天窗口', click: () => closeWindowWithoutPrompt(window) },
  ]))
  tray.on('double-click', () => restoreWindow(window))
  record.tray = tray
}

async function askCloseAction(window) {
  const result = await dialog.showMessageBox(window, {
    type: 'question',
    title: '关闭聊天窗口',
    message: '要关闭当前聊天窗口，还是最小化到系统托盘？',
    detail: '关闭最后一个聊天窗口 5 秒后，软件和本地后端将一起退出。',
    buttons: ['关闭此窗口', '最小化到托盘', '取消'],
    defaultId: 0,
    cancelId: 2,
    checkboxLabel: '记住我的选择',
    checkboxChecked: false,
    noLink: true,
  })
  if (window.isDestroyed() || result.response === 2) return
  const action = result.response === 0 ? 'close' : 'tray'
  if (result.checkboxChecked) {
    closePreference = action
    saveDesktopSettings()
  }
  if (action === 'tray') minimizeWindowToTray(window)
  else closeWindowWithoutPrompt(window)
}

function handleWindowClose(event, window) {
  if (isQuitting || allowedToClose.delete(window.id)) return
  event.preventDefault()
  if (closePreference === 'tray') minimizeWindowToTray(window)
  else if (closePreference === 'close') closeWindowWithoutPrompt(window)
  else void askCloseAction(window)
}

function emitDeepseekTabs(record) {
  if (record.window.isDestroyed()) return
  record.window.webContents.send('desktop:deepseek-tabs', {
    activeId: record.activeDeepseekTabId,
    tabs: [...record.deepseekTabs.values()].map((tab) => ({ id: tab.id, title: tab.title })),
  })
}

function updateDeepseekBounds(record) {
  const tab = record.deepseekTabs.get(record.activeDeepseekTabId)
  if (!tab) return
  const [width, height] = record.window.getContentSize()
  tab.view.setBounds({ x: 0, y: DEEPSEEK_TAB_HEIGHT, width, height: Math.max(1, height - DEEPSEEK_TAB_HEIGHT) })
}

function selectDeepseekTab(window, tabId) {
  const record = windows.get(window.id)
  if (!record) return false
  const current = record.deepseekTabs.get(record.activeDeepseekTabId)
  if (current) {
    try { record.window.contentView.removeChildView(current.view) } catch {}
  }
  record.activeDeepseekTabId = tabId || null
  const next = record.deepseekTabs.get(tabId)
  if (next) {
    record.window.contentView.addChildView(next.view)
    updateDeepseekBounds(record)
    next.view.webContents.focus()
  } else {
    record.window.webContents.focus()
  }
  emitDeepseekTabs(record)
  return true
}

function closeDeepseekTab(window, tabId) {
  const record = windows.get(window.id)
  const tab = record?.deepseekTabs.get(tabId)
  if (!record || !tab) return false
  const wasActive = record.activeDeepseekTabId === tabId
  if (wasActive) {
    try { record.window.contentView.removeChildView(tab.view) } catch {}
  }
  clearTimeout(tab.promptTimer)
  tab.view.webContents.close()
  record.deepseekTabs.delete(tabId)
  if (wasActive) {
    const remaining = [...record.deepseekTabs.keys()]
    selectDeepseekTab(window, remaining.at(-1) || null)
  } else {
    emitDeepseekTabs(record)
  }
  return true
}

function trySubmitDeepseekPrompt(tab) {
  // did-finish-load 与 did-navigate 会先后触发，promptSent 要等异步注入返回才置位，
  // 所以这里同步抢占 promptBusy，避免第二次注入把提示词又填一遍留在输入框里。
  if (tab.promptSent || tab.promptBusy || tab.view.webContents.isDestroyed()) return
  tab.promptBusy = true
  clearTimeout(tab.promptTimer)
  tab.promptTimer = null
  const script = `(() => {
    const prompt = ${JSON.stringify(tab.prompt)};
    const candidates = [
      'textarea',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      '[data-testid*="chat-input"]',
      '[class*="chat-input"] textarea'
    ];
    const input = candidates.map((selector) => document.querySelector(selector)).find(Boolean);
    if (!input || input.offsetParent === null) return false;
    input.focus();
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, prompt); else input.value = prompt;
    } else {
      input.textContent = prompt;
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const scope = input.closest('form') || input.parentElement?.parentElement || document;
    const buttons = [...scope.querySelectorAll('button')];
    const send = scope.querySelector('button[type="submit"]') || buttons.find((button) => {
      const text = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent].join(' ');
      return /发送|send|提交/i.test(text) && !button.disabled;
    });
    if (send && !send.disabled) {
      send.click();
      return true;
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  })()`
  tab.view.webContents.executeJavaScript(script, true).then((sent) => {
    tab.promptBusy = false
    if (sent) tab.promptSent = true
    else tab.promptTimer = setTimeout(() => trySubmitDeepseekPrompt(tab), 1500)
  }).catch(() => {
    tab.promptBusy = false
    tab.promptTimer = setTimeout(() => trySubmitDeepseekPrompt(tab), 1500)
  })
}

function createDeepseekTab(window, { action = 'ask', text = '' }) {
  const record = windows.get(window.id)
  if (!record || !text.trim()) return null
  const labels = {
    ask: '询问',
    explainCode: '解释代码',
    findIssues: '查找问题',
    optimizeCode: '优化代码',
  }
  const template = enhancements.prompts[action] || DEFAULT_ENHANCEMENTS.prompts[action] || '{content}'
  const prompt = template.includes('{content}')
    ? template.replaceAll('{content}', text)
    : `${template}\n\n${text}`
  const id = crypto.randomUUID()
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:deepseek',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const tab = { id, title: labels[action] || 'DeepSeek', prompt, promptSent: false, promptBusy: false, promptTimer: null, view }
  record.deepseekTabs.set(id, tab)
  view.webContents.on('did-finish-load', () => trySubmitDeepseekPrompt(tab))
  view.webContents.on('did-navigate', () => trySubmitDeepseekPrompt(tab))
  view.webContents.on('context-menu', (_event, params) => {
    const template = []
    if (params.selectionText) template.push({ label: '复制', click: () => clipboard.writeText(params.selectionText) })
    template.push({ role: 'selectAll', label: '全选' })
    Menu.buildFromTemplate(template).popup({ window })
  })
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('http://') && !url.startsWith('https://')) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 920,
        height: 720,
        autoHideMenuBar: true,
        icon: iconPath,
        webPreferences: {
          partition: 'persist:deepseek',
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    }
  })
  view.webContents.loadURL(enhancements.deepseekUrl)
  selectDeepseekTab(window, id)
  return id
}

async function injectEnhancements(window) {
  try {
    const [script, css] = await Promise.all([
      fs.promises.readFile(pageEnhancementsPath, 'utf8'),
      fs.promises.readFile(enhancementsCssPath, 'utf8'),
    ])
    await window.webContents.insertCSS(css)
    await window.webContents.executeJavaScript(script, true)
  } catch (error) {
    console.error('加载桌面增强功能失败', error)
  }
}

function createWindow() {
  cancelScheduledShutdown()
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  const record = {
    window,
    tray: null,
    deepseekTabs: new Map(),
    activeDeepseekTabId: null,
  }
  windows.set(window.id, record)
  window.once('ready-to-show', () => window.show())
  window.on('resize', () => updateDeepseekBounds(record))
  window.on('close', (event) => handleWindowClose(event, window))
  window.on('closed', () => {
    destroyWindowTray(window.id)
    for (const tab of record.deepseekTabs.values()) clearTimeout(tab.promptTimer)
    windows.delete(window.id)
    scheduleShutdownIfEmpty()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(backendUrl)) return
    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
  })
  window.webContents.on('did-finish-load', () => void injectEnhancements(window))
  void window.loadURL(backendUrl)
  return window
}

async function acquireApiLock() {
  let release
  const current = new Promise((resolve) => { release = resolve })
  const previous = apiLockTail
  apiLockTail = current
  await previous
  return release
}

function apiAttemptPlan(model) {
  const enabled = enhancements.apiList.filter((item) => item.enabled)
  if (!enabled.length) return []
  const cachedId = enhancements.modelApiMap[model]
  const cachedIndex = enabled.findIndex((item) => item.id === cachedId)
  const ordered = cachedIndex >= 0
    ? [...enabled.slice(cachedIndex), ...enabled.slice(0, cachedIndex)]
    : enabled
  return ordered.map(({ id, name }) => ({ id, name }))
}

async function beginApiAttempt(payload) {
  const apiId = typeof payload === 'string' ? payload : payload?.apiId
  const api = enhancements.apiList.find((item) => item.id === apiId && item.enabled)
  if (!api) throw new Error('API 配置不存在或已禁用')
  const release = await acquireApiLock()
  const token = crypto.randomUUID()
  const timer = setTimeout(() => finishApiAttempt(token).catch(() => {}), 45000)
  apiAttemptLocks.set(token, { release, timer })
  try {
    await requestBackend('PUT', '/api/settings', {
      base_url: normalizeBaseUrl(api.baseUrl),
      api_key: api.apiKey || '',
    })
    return token
  } catch (error) {
    clearTimeout(timer)
    apiAttemptLocks.delete(token)
    release()
    throw error
  }
}

async function finishApiAttempt(token) {
  const lock = apiAttemptLocks.get(token)
  if (!lock) return false
  apiAttemptLocks.delete(token)
  clearTimeout(lock.timer)
  try {
    await requestBackend('PUT', '/api/settings', { base_url: '', api_key: '' })
  } catch (error) {
    console.error('清除临时 API 设置失败', error)
  } finally {
    lock.release()
  }
  return true
}

function cleanupFailedAttempt(payload) {
  const databasePath = path.join(app.getPath('userData'), 'data', 'chatbot.db')
  if (!fs.existsSync(databasePath) || !payload?.conversationId) return false
  const { DatabaseSync } = require('node:sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;')
    let activeLeafId = payload.parentId || null
    if (payload.assistantMessageId) {
      if (payload.regenerate) {
        const row = database.prepare('SELECT parent_id FROM messages WHERE id=? AND conversation_id=?').get(
          payload.assistantMessageId,
          payload.conversationId,
        )
        activeLeafId = row?.parent_id || activeLeafId
      }
      database.prepare('DELETE FROM messages WHERE id=? AND conversation_id=?').run(
        payload.assistantMessageId,
        payload.conversationId,
      )
    }
    if (payload.userMessageId && !payload.regenerate) {
      database.prepare('DELETE FROM messages WHERE id=? AND conversation_id=?').run(
        payload.userMessageId,
        payload.conversationId,
      )
    }
    database.prepare('UPDATE conversations SET active_leaf_id=? WHERE id=?').run(
      activeLeafId,
      payload.conversationId,
    )
    database.exec('COMMIT;')
    return true
  } catch (error) {
    try { database.exec('ROLLBACK;') } catch {}
    throw error
  } finally {
    database.close()
  }
}

function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '新建窗口', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { role: 'close', label: '关闭当前窗口' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
  ]))
}

ipcMain.handle('desktop:new-window', () => { createWindow(); return true })
ipcMain.handle('desktop:request-close', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return false
  setTimeout(() => { if (!window.isDestroyed()) window.close() }, 100)
  return true
})
ipcMain.handle('desktop:get-window-count', () => windows.size)
ipcMain.handle('desktop:get-close-preference', () => closePreference)
ipcMain.handle('desktop:set-close-preference', (_event, preference) => {
  if (!VALID_CLOSE_PREFERENCES.has(preference)) throw new Error('无效的关闭行为')
  closePreference = preference
  saveDesktopSettings()
  return closePreference
})
ipcMain.handle('desktop:get-enhancements', () => publicEnhancementSettings())
ipcMain.handle('desktop:save-enhancements', (_event, payload) => saveEnhancementSettings(payload))
ipcMain.handle('desktop:reveal-api-key', (_event, apiId) => {
  const api = enhancements.apiList.find((item) => item.id === apiId)
  return api ? api.apiKey || '' : ''
})
ipcMain.handle('desktop:get-api-plan', (_event, model) => {
  const modelName = String(model || '')
  const enabled = enhancements.apiList.filter((item) => item.enabled)
  const cachedId = enhancements.modelApiMap[modelName]
  return {
    attempts: apiAttemptPlan(modelName),
    timeoutMs: enhancements.apiTimeoutSeconds * 1000,
    matched: Boolean(cachedId && enabled.some((item) => item.id === cachedId)),
  }
})
ipcMain.handle('desktop:begin-api-attempt', (_event, apiId) => beginApiAttempt(apiId))
ipcMain.handle('desktop:end-api-attempt', (_event, token) => finishApiAttempt(token))
ipcMain.handle('desktop:mark-api-success', (_event, { model, apiId }) => {
  if (enhancements.apiList.some((item) => item.id === apiId && item.enabled)) {
    enhancements.modelApiMap[String(model || '')] = apiId
    saveDesktopSettings()
  }
  return true
})
ipcMain.handle('desktop:cleanup-api-attempt', (_event, payload) => cleanupFailedAttempt(payload))
ipcMain.handle('desktop:show-context-menu', (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || !payload?.text) return false
  const menu = [
    { label: '复制', click: () => clipboard.writeText(payload.text) },
    { label: '询问', click: () => createDeepseekTab(window, { action: 'ask', text: payload.text }) },
  ]
  if (payload.isCode) {
    menu.push(
      { type: 'separator' },
      { label: '解释代码', click: () => createDeepseekTab(window, { action: 'explainCode', text: payload.text }) },
      { label: '查找问题', click: () => createDeepseekTab(window, { action: 'findIssues', text: payload.text }) },
      { label: '优化代码', click: () => createDeepseekTab(window, { action: 'optimizeCode', text: payload.text }) },
    )
  }
  Menu.buildFromTemplate(menu).popup({ window })
  return true
})
ipcMain.handle('desktop:open-deepseek', (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  return window ? createDeepseekTab(window, payload) : null
})
ipcMain.handle('desktop:select-deepseek-tab', (event, tabId) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  return window ? selectDeepseekTab(window, tabId) : false
})
ipcMain.handle('desktop:close-deepseek-tab', (event, tabId) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  return window ? closeDeepseekTab(window, tabId) : false
})

ipcMain.handle('desktop:diagnostics-log', (event, payload) => {
  const items = Array.isArray(payload) ? payload : [payload]
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    diag.record(
      item.level || 'INFO',
      item.module || 'renderer',
      item.message || '',
      item.fields,
      { source: 'frontend', traceId: item.trace_id || item.traceId },
    )
  }
  return { accepted: items.length }
})
ipcMain.handle('desktop:diagnostics-info', () => ({
  ...diag.paths(),
  appVersion: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: `${process.platform} ${os.release()}`,
  arch: process.arch,
}))
ipcMain.handle('desktop:diagnostics-open-log-dir', async () => {
  const { logDir } = diag.paths()
  const error = await shell.openPath(logDir)
  return { opened: !error, error: error || '' }
})
ipcMain.handle('desktop:diagnostics-export-bundle', () => exportDiagnosticsBundle())
/** 打开诊断文件夹（崩溃日志归档的根目录）。目录不存在时先建出来，免得打开失败。 */
ipcMain.handle('desktop:diagnostics-open-archive-dir', async () => {
  const root = archive.archiveRoot(diag.paths().logDir)
  try {
    fs.mkdirSync(root, { recursive: true })
  } catch {
    /* 建不出来就让 openPath 去报错 */
  }
  const error = await shell.openPath(root)
  const pending = archive.listArchives(diag.paths().logDir).filter((item) => item.status === 'pending')
  return { opened: !error, error: error || '', path: root, pending: pending.length }
})
ipcMain.handle('desktop:diagnostics-copy', (event, text) => {
  clipboard.writeText(String(text ?? ''))
  return true
})

/**
 * 上次异常退出后的提示。
 *
 * 顺序是先打包再弹窗：闪退时后端多半没起来，等用户点按钮才打包很可能又赶上一次崩溃，
 * 所以日志先落盘成 `未处理-…` 文件夹，弹窗只是告知 + 提供入口。用户点忽略也已经存好了。
 */
function promptLastRunCrashed(lastRun) {
  const latest = lastRun.crashes[lastRun.crashes.length - 1]
  const detail = latest
    ? `最近一次记录：${latest.timestamp}\n${latest.kind}：${latest.message}`
    : '没有找到崩溃详情，日志里可能仍有线索。'

  const result = archive.createArchive({
    logDir: diag.paths().logDir,
    reason: lastRun.reason,
    crashes: lastRun.crashes,
    env: {
      appVersion: app.getVersion(),
      previousVersion: lastRun.previousVersion,
      execPath: process.execPath,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform} ${os.release()}`,
      arch: process.arch,
    },
  })

  if (result.created) diag.info('diagnostics', '已生成诊断文件夹', { name: result.name, files: result.files })
  else diag.error('diagnostics', `生成诊断文件夹失败：${result.error}`)

  const location = result.created
    ? `日志已自动打包到：\n${result.name}\n（位于日志目录的 diagnostics 文件夹内，文件夹里有说明.md）`
    : `自动打包日志失败：${result.error}\n可以手动打开日志文件夹查看。`

  dialog
    .showMessageBox({
      type: 'warning',
      title: '上次运行异常退出',
      message: '上次运行异常退出',
      detail: `${detail}\n\n${location}`,
      buttons: result.created
        ? ['打开文件夹', '标记为已处理', '忽略']
        : ['打开日志文件夹', '忽略'],
      defaultId: 0,
      cancelId: result.created ? 2 : 1,
      noLink: true,
    })
    .then(({ response }) => {
      if (!result.created) {
        if (response === 0) shell.openPath(diag.paths().logDir)
        return
      }
      if (response === 0) shell.openPath(result.dir)
      else if (response === 1) {
        const marked = archive.markProcessed(result.dir)
        diag.info('diagnostics', marked.ok ? '诊断文件夹已标记为已处理' : `标记失败：${marked.error}`)
      }
    })
    .catch(() => { /* 对话框失败不影响启动 */ })
}

/** 从后端拉诊断包并让用户选保存位置。后端不可用时退化为打开日志目录。 */
async function exportDiagnosticsBundle() {
  if (!backendUrl) {
    await shell.openPath(diag.paths().logDir)
    return { saved: false, reason: 'backend-unavailable' }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出诊断包',
    defaultPath: path.join(app.getPath('downloads'), `chatbot-diagnostics-${stamp}.zip`),
    filters: [{ name: '诊断包', extensions: ['zip'] }],
  })
  if (canceled || !filePath) return { saved: false, reason: 'canceled' }
  try {
    const result = await fetchBundle(filePath)
    diag.info('diagnostics', '已导出诊断包', {
      bytes: result.bytes, containsSensitive: result.containsSensitive,
    })
    if (result.containsSensitive) {
      dialog.showMessageBox({
        type: 'warning',
        title: '诊断包含敏感信息',
        message: '这份诊断包可能含有对话正文',
        detail: '所覆盖的时间段内开启过「详细日志」，包中可能包含完整的请求与响应正文。分享前请自行确认。',
        buttons: ['我知道了'],
        noLink: true,
      }).catch(() => {})
    }
    return { saved: true, path: filePath, ...result }
  } catch (error) {
    diag.error('diagnostics', `导出诊断包失败：${error.message}`)
    dialog.showErrorBox('导出失败', error.message)
    return { saved: false, reason: error.message }
  }
}

function fetchBundle(filePath) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${backendUrl}/api/diagnostics/bundle`, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`后端返回 ${response.statusCode}`))
        return
      }
      const containsSensitive = response.headers['x-contains-sensitive'] === '1'
      const file = fs.createWriteStream(filePath)
      let bytes = 0
      response.on('data', (chunk) => { bytes += chunk.length })
      response.pipe(file)
      file.on('finish', () => file.close(() => resolve({ bytes, containsSensitive })))
      file.on('error', reject)
    })
    request.setTimeout(60000, () => request.destroy(new Error('导出超时')))
    request.on('error', reject)
  })
}

app.on('render-process-gone', (event, contents, details) => {
  reportCrash(
    'renderProcessGone',
    `渲染进程退出：${details?.reason ?? 'unknown'}`,
    '',
    { reason: details?.reason, exitCode: details?.exitCode, url: contents?.getURL?.() },
  )
})
app.on('child-process-gone', (event, details) => {
  reportCrash(
    'childProcessGone',
    `子进程退出：${details?.type ?? 'unknown'} / ${details?.reason ?? 'unknown'}`,
    '',
    { type: details?.type, reason: details?.reason, exitCode: details?.exitCode },
  )
})

app.on('second-instance', () => { if (backendUrl) createWindow() })
app.on('window-all-closed', () => {})
app.on('before-quit', () => {
  isQuitting = true
  cancelScheduledShutdown()
  for (const record of windows.values()) record.tray?.destroy()
  diag.info('lifecycle', '应用正常退出')
  stopBackend()
  // 顺序要紧：先落标记再排空队列，中途被杀也不会误判成崩溃。
  diag.markCleanExit()
  diag.flushSync()
})

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    const lastRun = diag.consumeCleanExitFlag(app.getVersion())
    diag.info('lifecycle', '应用启动', {
      version: app.getVersion(),
      packaged: app.isPackaged,
      lastRunClean: lastRun.wasClean,
      lastRunReason: lastRun.reason,
      previousVersion: lastRun.previousVersion,
    })
    try {
      migrateSettingsLocation()
      loadDesktopSettings()
      migrateLegacyData()
      await startBackend()
      await migrateLegacyApiSettings()
      installApplicationMenu()
      if (process.platform === 'win32') {
        app.setUserTasks([{
          program: process.execPath,
          arguments: '--new-window',
          iconPath: process.execPath,
          iconIndex: 0,
          title: '新建聊天窗口',
          description: '打开一个新的 AI Chatbot 窗口',
        }])
      }
      createWindow()
      if (!lastRun.wasClean) promptLastRunCrashed(lastRun)
      // 清理放在窗口出来之后，纯磁盘操作不该拖慢启动；每天最多跑一次由模块内部把关。
      const swept = archive.cleanup(diag.paths().logDir)
      if (!swept.skipped && swept.removed.length) {
        diag.info('diagnostics', '已清理过期诊断文件夹', { count: swept.removed.length })
      }
    } catch (error) {
      diag.record('CRITICAL', 'lifecycle', `启动失败：${error.message}`, {}, { sync: true })
      diag.recordCrash('startupFailed', error.message, error.stack ?? '')
      diag.flushSync()
      stopBackend()
      dialog.showErrorBox('启动失败', `${error.message}\n\n日志目录：${diag.paths().logDir}`)
      app.exit(1)
    }
  })
}
