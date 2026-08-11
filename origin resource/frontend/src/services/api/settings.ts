import type { Settings } from '../../types'
import { requestJson } from './http'

export function fetchSettings(): Promise<Settings> {
  return requestJson('/settings')
}

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return requestJson('/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

