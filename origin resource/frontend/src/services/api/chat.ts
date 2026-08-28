import type { Attachment } from '../../types'
import { API_BASE } from './http'

export interface ChatEvent {
  type:
    | 'start'
    | 'thinking'
    | 'content'
    | 'error'
    | 'done'
    | 'title'
    | 'context_compacted'
    | 'tool_start'
    | 'tool_progress'
    | 'tool_end'
    | 'tool_error'
  [key: string]: unknown
}

export interface ChatRequest {
  conversation_id: string
  content?: string
  attachments?: Attachment[]
  model?: string
  parent_id?: string | null
  regenerate_from?: string
  continue_from?: string
  thinking?: string
  /**
   * 选中的 API 渠道 id（只有桌面端有意义）。
   *
   * 后端不用它——渠道地址和密钥由桌面层在发请求前临时写进全局设置。它存在的
   * 唯一理由是桌面层注入的 fetch 补丁要从请求体里读出该调哪一家；后端的
   * `ChatBody` 也声明了同名字段，免得被 pydantic 当多余字段悄悄丢掉。
   */
  api_id?: string
}

/**
 * 读取后端的 SSE 流。
 *
 * 普通接口一次返回完整 JSON；聊天接口会持续返回多个 `data:` 事件，
 * 这样模型每生成一小段文字，页面就能立即显示，而不必等待整段完成。
 */
export async function streamChat(
  body: ChatRequest,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({ detail: '请求失败' }))
    throw new Error((payload as { detail?: string }).detail || '请求失败')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // 每两个换行表示一个完整 SSE 事件；最后一段可能尚未接收完整，留到下一轮。
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const line = block.trim()
      if (!line.startsWith('data:')) continue
      try {
        onEvent(JSON.parse(line.slice(5)) as ChatEvent)
      } catch {
        // 某个事件格式错误时忽略该事件，避免整场流式对话中断。
      }
    }
  }
}
