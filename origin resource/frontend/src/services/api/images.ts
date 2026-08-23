import type { ImageRecord } from '../../types'
import { API_BASE, requestBlob, requestJson, requestVoid } from './http'

export interface GenerateImageRequest {
  prompt: string
  negative_prompt?: string
  model?: string
  size?: string
  quality?: string
  n?: number
}

export function listImages(): Promise<ImageRecord[]> {
  return requestJson('/images')
}

export function generateImages(body: GenerateImageRequest): Promise<ImageRecord> {
  return requestJson('/images/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 参考图：图片文件 + 需要借用的特征说明。 */
export interface ReferenceImageInput {
  file: File
  note: string
}

export function editImage(
  file: File,
  body: Omit<GenerateImageRequest, 'n'>,
  references: ReferenceImageInput[] = [],
): Promise<ImageRecord> {
  const form = new FormData()
  form.append('file', file)
  form.append('prompt', body.prompt)
  form.append('negative_prompt', body.negative_prompt ?? '')
  for (const ref of references) {
    form.append('references', ref.file)
  }
  if (references.length > 0) {
    form.append('reference_notes', JSON.stringify(references.map((ref) => ref.note ?? '')))
  }
  if (body.model) form.append('model', body.model)
  if (body.size) form.append('size', body.size)
  if (body.quality) form.append('quality', body.quality)
  return requestJson('/images/edit', { method: 'POST', body: form })
}

export function deleteImageRecord(id: string): Promise<void> {
  return requestVoid(`/images/${id}`, { method: 'DELETE' })
}

export function imageFileUrl(name: string): string {
  return `${API_BASE}/images/file/${encodeURIComponent(name)}`
}

export function migrateOldImages(): Promise<{ imported: number }> {
  return requestJson('/images/migrate', { method: 'POST' })
}

/**
 * 一种可导出的格式。清单由后端探测得到——同一份代码在不同机器上
 * 未必都能编码 HEIC/AVIF，写死在前端会让用户点到必然失败的选项。
 */
export interface ExportFormat {
  key: string
  label: string
  ext: string
  mime: string
  /** 是否保留透明通道。false 时导出前要把透明区填成背景色。 */
  alpha: boolean
  /** 是否有「质量」参数。 */
  quality: boolean
  /** 是否有 DPI 参数。 */
  dpi: boolean
  /** 是否有压缩方式参数（目前只有 TIFF）。 */
  compression: boolean
  note: string
}

export interface ExportImageRequest {
  name: string
  format: string
  quality?: number
  tiff_compression?: string
  dpi?: number
  background?: string
  width?: number | null
  height?: number | null
}

export function listExportFormats(): Promise<{ formats: ExportFormat[] }> {
  return requestJson('/images/export/formats')
}

export function exportImage(body: ExportImageRequest): Promise<{ blob: Blob; filename: string }> {
  return requestBlob('/images/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

