import type { ConversationMeta, ConversationTree, MessageSearchHit } from '../../types'
import { requestJson, requestVoid } from './http'

export function listConversations(): Promise<ConversationMeta[]> {
  return requestJson('/conversations')
}

export function createConversation(
  opts: {
    projectId?: string | null
    styleId?: string | null
    memoryEnabled?: boolean
    memoryIds?: string[]
  } = {},
): Promise<ConversationMeta> {
  return requestJson('/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: opts.projectId ?? null,
      style_id: opts.styleId ?? null,
      memory_enabled: opts.memoryEnabled ?? false,
      memory_ids: opts.memoryIds ?? [],
    }),
  })
}

export function setConversationProject(id: string, projectId: string | null): Promise<void> {
  return requestVoid(`/conversations/${id}/project`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId }),
  })
}

export function setConversationStyle(id: string, styleId: string | null): Promise<void> {
  return requestVoid(`/conversations/${id}/style`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ style_id: styleId }),
  })
}

export function setConversationMemory(
  id: string,
  enabled: boolean,
  memoryIds: string[],
): Promise<void> {
  return requestVoid(`/conversations/${id}/memory`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, memory_ids: memoryIds }),
  })
}

export function searchConversations(q: string): Promise<MessageSearchHit[]> {
  return requestJson(`/conversations/search?q=${encodeURIComponent(q)}`)
}

export function getConversation(id: string): Promise<ConversationTree> {
  return requestJson(`/conversations/${id}`)
}

export function renameConversation(id: string, title: string): Promise<void> {
  return requestVoid(`/conversations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

export function deleteConversation(id: string): Promise<void> {
  return requestVoid(`/conversations/${id}`, { method: 'DELETE' })
}

export async function setActiveLeaf(conversationId: string, leafId: string): Promise<string> {
  const data = await requestJson<{ active_leaf_id: string }>(
    `/conversations/${conversationId}/active_leaf`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaf_id: leafId }),
    },
  )
  return data.active_leaf_id
}

export function migrateOldData(): Promise<{ imported: number }> {
  return requestJson('/migrate', { method: 'POST' })
}

