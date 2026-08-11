import type { Memory, MemoryList } from '../../types'
import { requestJson, requestVoid } from './http'

export function listMemories(): Promise<MemoryList> {
  return requestJson('/memories')
}

/** duplicate 为真表示内容与已有记忆完全相同，后端没有新写入。 */
export function createMemory(
  content: string,
): Promise<{ memory: Memory; duplicate: boolean; trimmed: number }> {
  return requestJson('/memories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

export function updateMemory(id: string, content: string): Promise<Memory> {
  return requestJson(`/memories/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

export function deleteMemory(id: string): Promise<void> {
  return requestVoid(`/memories/${id}`, { method: 'DELETE' })
}

export function clearMemories(): Promise<void> {
  return requestVoid('/memories/clear', { method: 'POST' })
}
