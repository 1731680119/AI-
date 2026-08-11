import type { Attachment } from '../../types'
import { requestJson } from './http'

export function uploadFile(file: File): Promise<Attachment> {
  const form = new FormData()
  form.append('file', file)
  return requestJson('/upload', { method: 'POST', body: form })
}

