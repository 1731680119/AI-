import { API_BASE, requestJson } from './http'

export interface LogRecord {
  seq: number
  ts: string
  level: string
  source: string
  logger: string
  message: string
  trace_id: string
  fields: Record<string, unknown>
  stack: string | null
}

export interface LogQuery {
  limit?: number
  levels?: string[]
  sources?: string[]
  search?: string
  traceId?: string
}

export interface SystemInfo {
  app_version: string
  platform: string
  python: string
  arch: string
  cpu_count: number
  data_dir: string
  log_dir: string
  verbose_logging: boolean
  log_files: number
  log_bytes: number
  generated_at: string
}

export interface CrashRecord {
  at: string
  kind: string
  source: string
  message: string
  stack: string
  app_version: string
}

function buildQuery(query: LogQuery): string {
  const params = new URLSearchParams()
  if (query.limit) params.set('limit', String(query.limit))
  if (query.levels?.length) params.set('level', query.levels.join(','))
  if (query.sources?.length) params.set('source', query.sources.join(','))
  if (query.search?.trim()) params.set('search', query.search.trim())
  if (query.traceId?.trim()) params.set('trace_id', query.traceId.trim())
  return params.toString()
}

export async function fetchLogs(
  query: LogQuery = {},
): Promise<{ records: LogRecord[]; count: number; verbose: boolean }> {
  return requestJson(`/diagnostics/logs?${buildQuery(query)}`)
}

export function fetchSystemInfo(): Promise<SystemInfo> {
  return requestJson('/diagnostics/info')
}

export function fetchLogDir(): Promise<{ path: string }> {
  return requestJson('/diagnostics/log-dir')
}

export function fetchCrashes(): Promise<{ crashes: CrashRecord[] }> {
  return requestJson('/diagnostics/crashes')
}

export function clearCrashes(): Promise<{ cleared: boolean }> {
  return requestJson('/diagnostics/crashes', { method: 'DELETE' })
}

export function setVerbose(enabled: boolean): Promise<{ verbose: boolean }> {
  return requestJson('/diagnostics/verbose', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

/**
 * 订阅实时日志。返回一个取消函数，组件卸载时必须调用，
 * 否则 SSE 连接会一直挂着，后端订阅队列也不会释放。
 */
export function streamLogs(
  query: Pick<LogQuery, 'levels' | 'sources'>,
  onRecord: (record: LogRecord) => void,
  onStateChange?: (connected: boolean) => void,
): () => void {
  const params = new URLSearchParams()
  if (query.levels?.length) params.set('level', query.levels.join(','))
  if (query.sources?.length) params.set('source', query.sources.join(','))

  const source = new EventSource(`${API_BASE}/diagnostics/stream?${params}`)
  source.onopen = () => onStateChange?.(true)
  source.onerror = () => onStateChange?.(false)
  source.onmessage = (event) => {
    try {
      onRecord(JSON.parse(event.data) as LogRecord)
    } catch {
      /* 心跳或半条数据，忽略 */
    }
  }
  return () => {
    source.close()
    onStateChange?.(false)
  }
}

/** 诊断包下载地址。交给 Electron 或浏览器直接下载，不经过 fetch。 */
export function bundleUrl(days = 3): string {
  return `${API_BASE}/diagnostics/bundle?days=${days}`
}
