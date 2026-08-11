/**
 * 前端日志采集。
 *
 * 界面里发生的事（用户操作、请求、报错）都汇总到这里，攒成一批后交给后端
 * 落盘，与 Electron 主进程、后端自己的日志进入同一份文件。前端不直接写文件，
 * 也不各自打 console，排查问题时只看一份日志就够。
 */
import { API_BASE } from './api/base'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'

export type LogEntry = {
  level: LogLevel
  source: 'frontend'
  module: string
  message: string
  timestamp: string
  trace_id?: string
  fields?: Record<string, unknown>
  stack?: string
}

const FLUSH_INTERVAL_MS = 2000
const MAX_QUEUE = 500
/** 单批上限。一次报错常连带一串日志，分批发避免请求体过大。 */
const MAX_BATCH = 100

const SECRET_KEYS = /^(api_key|apiKey|key|token|authorization|password|secret)$/i
const SK_PATTERN = /\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{4,}\b/g

let queue: LogEntry[] = []
let timer: number | null = null
let sending = false
let dropped = 0

function maskText(value: string): string {
  return value.replace(SK_PATTERN, '$1****')
}

/** 结构化字段脱敏。密钥类键只留前 4 位，其余按文本规则处理。 */
function maskFields(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskText(value)
  if (depth >= 4 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => maskFields(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.test(key) && typeof item === 'string' && item
      ? `${item.slice(0, 4)}****`
      : maskFields(item, depth + 1)
  }
  return out
}

export function newTraceId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function log(
  level: LogLevel,
  module: string,
  message: string,
  fields?: Record<string, unknown>,
  extra?: { traceId?: string; stack?: string },
): void {
  const entry: LogEntry = {
    level,
    source: 'frontend',
    module,
    message: maskText(String(message ?? '')),
    timestamp: new Date().toISOString(),
    trace_id: extra?.traceId,
    fields: fields ? (maskFields(fields) as Record<string, unknown>) : undefined,
    stack: extra?.stack ? maskText(extra.stack) : undefined,
  }
  if (queue.length >= MAX_QUEUE) {
    queue.shift()
    dropped += 1
  }
  queue.push(entry)
  // 错误级别不等下一个周期，立刻发走，避免页面随后崩掉带走这条日志。
  if (level === 'ERROR' || level === 'CRITICAL') void flush()
  else scheduleFlush()
}

export const logInfo = (module: string, message: string, fields?: Record<string, unknown>) =>
  log('INFO', module, message, fields)
export const logWarn = (module: string, message: string, fields?: Record<string, unknown>) =>
  log('WARNING', module, message, fields)
export const logError = (
  module: string,
  message: string,
  fields?: Record<string, unknown>,
  stack?: string,
) => log('ERROR', module, message, fields, { stack })

function scheduleFlush(): void {
  if (timer !== null) return
  timer = window.setTimeout(() => {
    timer = null
    void flush()
  }, FLUSH_INTERVAL_MS)
}

/** 把排队的日志交给后端。失败时放回队首，下一个周期重试。 */
export async function flush(): Promise<void> {
  if (sending || queue.length === 0) return
  sending = true
  const batch = queue.slice(0, MAX_BATCH)
  queue = queue.slice(batch.length)
  if (dropped > 0) {
    batch.unshift({
      level: 'WARNING',
      source: 'frontend',
      module: 'diagnostics',
      message: `前端日志队列溢出，已丢弃 ${dropped} 条`,
      timestamp: new Date().toISOString(),
    })
    dropped = 0
  }
  try {
    await fetch(`${API_BASE}/diagnostics/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      keepalive: true,
    })
  } catch {
    queue = batch.concat(queue).slice(-MAX_QUEUE)
  } finally {
    sending = false
    if (queue.length > 0) scheduleFlush()
  }
}
/** 记录一次用户操作。出问题时用来还原「用户做了什么」这条线。 */
export function logAction(action: string, fields?: Record<string, unknown>): void {
  log('INFO', 'action', action, fields)
}

let installed = false

/** 安装全局错误钩子。在 main.tsx 里调用一次。 */
export function installDiagnostics(): void {
  if (installed) return
  installed = true

  window.addEventListener('error', (event) => {
    // 图片、脚本加载失败也走这个事件，但没有 error 对象，单独记一条更清楚。
    if (!event.error && event.target && event.target !== window) {
      const target = event.target as HTMLElement & { src?: string; href?: string }
      log('WARNING', 'resource', `资源加载失败：${target.tagName}`, {
        url: target.src || target.href || '',
      })
      return
    }
    log(
      'ERROR',
      'window',
      event.message || '未捕获的异常',
      { filename: event.filename, line: event.lineno, column: event.colno },
      { stack: event.error?.stack },
    )
  }, true)

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const error = reason instanceof Error ? reason : null
    log(
      'ERROR',
      'window',
      `未处理的 Promise 拒绝：${error?.message ?? String(reason)}`,
      {},
      { stack: error?.stack },
    )
  })

  // 关页面前把剩下的日志发走，否则最后几条会随页面一起消失。
  window.addEventListener('pagehide', () => { void flush() })

  logInfo('lifecycle', '界面已加载', {
    userAgent: navigator.userAgent,
    language: navigator.language,
    screen: `${window.screen.width}x${window.screen.height}`,
    url: window.location.pathname,
  })
}

