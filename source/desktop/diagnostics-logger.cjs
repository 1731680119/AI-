/**
 * 桌面层诊断日志。
 *
 * 设计要点：后端是唯一的日志文件写入方，主进程与渲染进程的日志都通过
 * /api/diagnostics/ingest 交给后端落盘，避免多进程同时写同一文件。
 * 但主进程在后端起来之前（启动、spawn）和后端死掉之后（崩溃）也要能记日志，
 * 所以这里额外维护一个本地兜底文件，写在后端的 LOG_DIR 里，
 * 这样导出诊断包时会被一起打包。
 */
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const MAX_QUEUE = 1000
const FLUSH_INTERVAL_MS = 1000
const FALLBACK_MAX_BYTES = 10 * 1024 * 1024
const KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{4,}\b/g
const TOKEN_FIELDS = new Set(['api_key', 'apiKey', 'key', 'token', 'authorization', 'password', 'secret'])

let logDir = ''
let fallbackPath = ''
let cleanExitPath = ''
let sessionPath = ''
let crashPath = ''
let resolveBackendUrl = () => ''
let queue = []
let flushTimer = null
let flushing = false
let dropped = 0

function mask(value) {
  if (typeof value !== 'string') return value
  let out = value.replace(KEY_PATTERN, '$1****')
  const home = process.env.USERPROFILE || process.env.HOME
  if (home) out = out.split(home).join('%USERPROFILE%')
  return out
}

function maskFields(fields) {
  if (!fields || typeof fields !== 'object') return undefined
  const out = {}
  for (const [key, value] of Object.entries(fields)) {
    if (TOKEN_FIELDS.has(key) && typeof value === 'string' && value) {
      out[key] = `${value.slice(0, 4)}****`
    } else if (typeof value === 'string') {
      out[key] = mask(value)
    } else if (value && typeof value === 'object') {
      out[key] = maskFields(value)
    } else {
      out[key] = value
    }
  }
  return out
}

function init(options) {
  logDir = options.logDir
  resolveBackendUrl = options.backendUrl
  fs.mkdirSync(logDir, { recursive: true })
  fallbackPath = path.join(logDir, 'desktop-fallback.log')
  cleanExitPath = path.join(logDir, '.clean-exit')
  sessionPath = path.join(logDir, '.session')
  crashPath = path.join(logDir, 'crashes.json')
  rotateFallback()
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)
  flushTimer.unref?.()
}

function rotateFallback() {
  try {
    const stat = fs.statSync(fallbackPath)
    if (stat.size >= FALLBACK_MAX_BYTES) {
      fs.renameSync(fallbackPath, `${fallbackPath}.1`)
    }
  } catch {
    /* 文件不存在，无需轮转 */
  }
}

/** 同步写兜底文件。崩溃路径必须走同步写，否则进程死掉时缓冲区会丢。 */
function writeFallback(record) {
  if (!fallbackPath) return
  const stamp = record.timestamp
  const line = `[${stamp}] [${record.level}] [${record.source}.${record.module}] ${record.message}`
    + (record.fields ? ` | ${JSON.stringify(record.fields)}` : '')
  try {
    fs.appendFileSync(fallbackPath, `${line}\n`, 'utf8')
  } catch {
    /* 日志写失败不能影响主流程 */
  }
}

function record(level, module, message, fields, options = {}) {
  const item = {
    timestamp: new Date().toISOString(),
    level: String(level).toUpperCase(),
    source: options.source || 'desktop',
    module: String(module || 'main'),
    message: mask(String(message ?? '')),
    fields: maskFields(fields),
    trace_id: options.traceId,
  }
  if (options.sync || item.level === 'CRITICAL') {
    writeFallback(item)
  }
  if (queue.length >= MAX_QUEUE) {
    queue.shift()
    dropped += 1
  }
  queue.push(item)
  return item
}

const info = (module, message, fields) => record('INFO', module, message, fields)
const warn = (module, message, fields) => record('WARN', module, message, fields)
const error = (module, message, fields) => record('ERROR', module, message, fields)
const debug = (module, message, fields) => record('DEBUG', module, message, fields)

module.exports = {
  init, record, info, warn, error, debug, writeFallback,
  paths: () => ({ logDir, fallbackPath, cleanExitPath, sessionPath, crashPath }),
  _internal: {
    take: () => { const items = queue; queue = []; return items },
    restore: (items) => { queue = items.concat(queue).slice(-MAX_QUEUE) },
    droppedCount: () => dropped,
    isFlushing: () => flushing,
    setFlushing: (value) => { flushing = value },
    backendUrl: () => resolveBackendUrl(),
    stopTimer: () => { if (flushTimer) clearInterval(flushTimer); flushTimer = null },
  },
}
/** 把排队的日志批量交给后端落盘。后端不可用时退回本地兜底文件。 */
function flush() {
  if (flushing) return
  const items = module.exports._internal.take()
  if (!items.length) return
  const base = resolveBackendUrl()
  if (!base) {
    items.forEach(writeFallback)
    return
  }
  flushing = true
  const payload = Buffer.from(JSON.stringify(items), 'utf8')
  const url = new URL('/api/diagnostics/ingest', base)
  const request = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    },
    (response) => {
      response.resume()
      flushing = false
      if (response.statusCode !== 200) items.forEach(writeFallback)
    },
  )
  request.setTimeout(3000, () => request.destroy(new Error('ingest timeout')))
  request.on('error', () => {
    flushing = false
    items.forEach(writeFallback)
  })
  request.end(payload)
}

/** 退出前同步排空队列，保证最后几条不丢。 */
function flushSync() {
  module.exports._internal.stopTimer()
  module.exports._internal.take().forEach(writeFallback)
}

/** 记录一次崩溃，供下次启动时提示用户。 */
function recordCrash(kind, message, detail) {
  if (!crashPath) return
  let items = []
  try {
    items = JSON.parse(fs.readFileSync(crashPath, 'utf8'))
    if (!Array.isArray(items)) items = []
  } catch {
    items = []
  }
  items.push({
    timestamp: new Date().toISOString(),
    kind: String(kind),
    message: mask(String(message ?? '')),
    detail: mask(String(detail ?? '')).slice(0, 4000),
    source: 'desktop',
  })
  try {
    fs.writeFileSync(crashPath, JSON.stringify(items.slice(-50), null, 2), 'utf8')
  } catch {
    /* 忽略 */
  }
}

function readSession() {
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/**
 * 程序文件是否在上次启动之后被换过。覆盖安装同一个版本号时版本比对没有差异，
 * 但安装包一定会重写 exe，用它的修改时间兜底。
 */
function replacedSince(startedAt) {
  const started = Date.parse(startedAt ?? '')
  if (!Number.isFinite(started)) return false
  try {
    return fs.statSync(process.execPath).mtimeMs > started
  } catch {
    return false
  }
}

function writeSession(version) {
  try {
    fs.writeFileSync(sessionPath, JSON.stringify({
      pid: process.pid, version: String(version ?? ''), startedAt: new Date().toISOString(),
    }), 'utf8')
  } catch {
    /* 忽略 */
  }
}

/**
 * 判断上次运行是怎么结束的，随后登记本次运行。
 *
 * 光看 .clean-exit 在不在是不够的：首次安装、以及从没有这套日志的旧版本升级过来，
 * 标记文件本来就不存在，会被误判成崩溃。所以另外记一个 .session，只有"上次确实
 * 跑过（有 session）、又没留下干净退出标记"才算异常。安装包更新时 NSIS 会直接
 * 杀掉旧进程，同样走不到退出流程，靠 session 里的版本号和当前版本比一下就能区分。
 */
function consumeCleanExitFlag(currentVersion) {
  if (!cleanExitPath) return { wasClean: true, reason: 'untracked', crashes: [] }
  const hasCleanMarker = fs.existsSync(cleanExitPath)
  const session = readSession()
  try {
    if (hasCleanMarker) fs.unlinkSync(cleanExitPath)
  } catch {
    /* 忽略 */
  }

  let reason = 'crashed'
  if (hasCleanMarker) reason = 'clean'
  else if (!session) reason = 'untracked'
  else if (String(currentVersion ?? '') !== String(session.version ?? '')) reason = 'upgraded'
  else if (replacedSince(session.startedAt)) reason = 'upgraded'

  writeSession(currentVersion)

  let crashes = []
  try {
    crashes = JSON.parse(fs.readFileSync(crashPath, 'utf8'))
    if (!Array.isArray(crashes)) crashes = []
  } catch {
    crashes = []
  }
  return {
    wasClean: reason !== 'crashed',
    reason,
    previousVersion: session?.version ?? '',
    crashes: crashes.slice(-5),
  }
}

function markCleanExit() {
  if (!cleanExitPath) return
  try {
    fs.writeFileSync(cleanExitPath, new Date().toISOString(), 'utf8')
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(sessionPath, { force: true })
  } catch {
    /* 忽略 */
  }
}

module.exports.flush = flush
module.exports.flushSync = flushSync
module.exports.recordCrash = recordCrash
module.exports.consumeCleanExitFlag = consumeCleanExitFlag
module.exports.markCleanExit = markCleanExit
module.exports.mask = mask

