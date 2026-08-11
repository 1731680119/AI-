import type { Project } from '../../types'
import { requestJson, requestVoid } from './http'

export function listProjects(): Promise<Project[]> {
  return requestJson('/projects')
}

export function createProject(
  body: { name: string; description?: string; instructions?: string },
): Promise<Project> {
  return requestJson('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function updateProject(
  id: string,
  patch: Partial<Pick<Project, 'name' | 'description' | 'instructions'>>,
): Promise<Project> {
  return requestJson(`/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** 默认只解除会话的项目归属；deleteConversations 为真时连会话一起删。 */
export function deleteProject(id: string, deleteConversations = false): Promise<void> {
  return requestVoid(
    `/projects/${id}?delete_conversations=${deleteConversations}`,
    { method: 'DELETE' },
  )
}
