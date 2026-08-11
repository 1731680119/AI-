import { API_BASE } from './base'
import * as diag from '../diagnostics'

export { API_BASE }

type ErrorPayload = { detail?: string }

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
  const payload = await response.json().catch(() => ({} as ErrorPayload))
  const traceId = response.headers.get('X-Trace-Id') || ''
  const message = payload.detail || `请求失败（HTTP ${response.status}）`
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
