import { API_BASE } from './base'
import * as diag from '../diagnostics'

export { API_BASE }

/** FastAPI 422 返回数组，不应被插值成 [object Object]。 */
export function errorMessage(detail: unknown, fallback: string): string {
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      if (!item || typeof item !== 'object' || typeof item.msg !== 'string') return ''
      const field = Array.isArray(item.loc) ? item.loc.filter((part: unknown) => part !== 'body').join('.') : ''
      return field ? `${field}：${item.msg}` : item.msg
    }).filter(Boolean)
    if (messages.length) return messages.join('；')
  }
  return fallback
}

/**
 * 带诊断的请求封装。
 *
 * 每个请求生成一个 trace_id 通过 X-Trace-Id 发给后端，后端会把它写进自己的
 * 日志，于是同一次操作在前后端日志里是同一个编号，可以直接串起来看。
 * 日志上报接口本身不记录，否则会自己触发自己。
 */
async function send(url: string, init?: RequestInit): Promise<Response> {
  const quiet = url.startsWith('/diagnostics')
  const traceId = diag.newTraceId()
  const method = init?.method ?? 'GET'
  const started = performance.now()

  const headers = new Headers(init?.headers)
  headers.set('X-Trace-Id', traceId)

  let response: Response
  try {
    response = await fetch(`${API_BASE}${url}`, { ...init, headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!quiet) {
      diag.log('ERROR', 'request', `请求发送失败 ${method} ${url}：${message}`, {
        method, url, elapsed_ms: Math.round(performance.now() - started),
      }, { traceId })
    }
    throw new Error(`网络请求失败：${message}`)
  }

  if (!quiet) {
    diag.log(
      response.ok ? 'INFO' : 'WARNING',
      'request',
      `${method} ${url} → ${response.status}`,
      { method, url, status: response.status, elapsed_ms: Math.round(performance.now() - started) },
      { traceId },
    )
  }
  return response
}

async function failure(response: Response): Promise<Error> {
  const payload = await response.json().catch(() => ({}))
  const traceId = response.headers.get('X-Trace-Id') || ''
  const message = errorMessage(payload?.detail, `请求失败（HTTP ${response.status}）`)
  // 把 trace_id 带进错误提示，用户截图报障时也能定位到具体那一次请求。
  return new Error(traceId ? `${message}（编号 ${traceId}）` : message)
}

/**
 * 发送请求并解析 JSON。
 *
 * fetch 默认不会把 404、500 当成异常，因此在这里统一检查状态码，
 * 让页面只需要处理正常结果和 Error，不必在每个接口里重复判断。
 */
export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await send(url, init)
  if (!response.ok) throw await failure(response)
  return response.json() as Promise<T>
}

/** 用于删除、重命名等不关心响应正文的请求。 */
export async function requestVoid(url: string, init?: RequestInit): Promise<void> {
  const response = await send(url, init)
  if (!response.ok) throw await failure(response)
}

/**
 * 从 Content-Disposition 里取文件名。
 *
 * 后端为中文名同时给了 `filename`（ASCII 兜底）和 `filename*`（RFC 5987 百分号编码），
 * 优先用后者，取不到再退回前者，都没有就交给调用方自己起名。
 */
function parseFilename(header: string | null): string {
  if (!header) return ''
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1])
    } catch {
      /* 编码坏了就往下走 ASCII 兜底 */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain ? plain[1] : ''
}

/** 下载类接口：拿回二进制内容和后端建议的文件名。 */
export async function requestBlob(
  url: string,
  init?: RequestInit,
): Promise<{ blob: Blob; filename: string }> {
  const response = await send(url, init)
  if (!response.ok) throw await failure(response)
  return {
    blob: await response.blob(),
    filename: parseFilename(response.headers.get('Content-Disposition')),
  }
}
