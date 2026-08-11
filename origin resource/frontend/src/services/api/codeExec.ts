import { requestJson } from './http'

/**
 * 答复一次代码执行确认。
 *
 * 后端此刻停在等待上，所以这个请求必须发出去，否则那一轮对话会挂到超时。
 * code 非空表示用户改过代码，后端会对改后的版本重新做静态检查。
 */
export function submitCodeExecDecision(body: {
  request_id: string
  approved: boolean
  code?: string
  trust_conversation?: boolean
  conversation_id?: string
}): Promise<{ ok: boolean }> {
  return requestJson('/code-exec/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
