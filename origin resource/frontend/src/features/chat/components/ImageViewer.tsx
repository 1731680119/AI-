import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Download, ExternalLink, X } from 'lucide-react'

type DesktopImageBridge = {
  readImage?: (url: string) => Promise<{ data: Uint8Array; mimeType: string }>
  saveBinaryFile?: (payload: { data: ArrayBuffer; filename: string; extension: string; label: string }) => Promise<{ saved: boolean; reason?: string }>
  copyImage?: (data: ArrayBuffer) => Promise<boolean>
  copyToClipboard?: (text: string) => Promise<boolean>
}

const desktop = () => (window as unknown as { chatbotDesktop?: DesktopImageBridge }).chatbotDesktop

async function imageBlob(url: string): Promise<Blob> {
  const bridge = desktop()
  if (bridge?.readImage && /^https?:\/\//i.test(url)) {
    const result = await bridge.readImage(url)
    return new Blob([new Uint8Array(result.data)], { type: result.mimeType })
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`)
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) throw new Error('图片地址没有返回图片文件')
  if (blob.size > 30 * 1024 * 1024) throw new Error('图片超过 30 MB，无法复制或保存')
  return blob
}

function imageName(url: string, mimeType: string): { filename: string; extension: string } {
  const raw = new URL(url, location.href).pathname.split('/').pop() || 'image'
  const safe = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'image'
  const known = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg' }
  const extension = (known as Record<string, string>)[mimeType.split(';')[0]] || 'png'
  return { filename: /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(safe) ? safe : `${safe}.${extension}`, extension }
}

async function pngBytes(blob: Blob): Promise<ArrayBuffer> {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法处理图片')
    context.drawImage(image, 0, 0)
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('无法转换图片')), 'image/png'))
    return png.arrayBuffer()
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function ImageViewer({ src, alt, sourceUrl, onClose }: {
  src: string; alt?: string; sourceUrl?: string; onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const run = async (action: () => Promise<string>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try { setNotice(await action()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const copyLink = (url: string, label: string) => run(async () => {
    if (desktop()?.copyToClipboard) await desktop()!.copyToClipboard!(url)
    else await navigator.clipboard.writeText(url)
    return `已复制${label}`
  })

  const save = () => run(async () => {
    const blob = await imageBlob(src)
    if (!blob.type.startsWith('image/')) throw new Error('图片地址没有返回图片文件')
    const { filename, extension } = imageName(src, blob.type)
    const bridge = desktop()
    if (bridge?.saveBinaryFile) {
      const result = await bridge.saveBinaryFile({ data: await blob.arrayBuffer(), filename, extension, label: '图片' })
      if (!result.saved) {
        if (result.reason === 'canceled') return ''
        throw new Error(result.reason || '保存失败')
      }
    } else {
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    return '图片已保存'
  })

  const copyImage = () => run(async () => {
    const data = await pngBytes(await imageBlob(src))
    const bridge = desktop()
    if (bridge?.copyImage) {
      if (!await bridge.copyImage(data)) throw new Error('复制图片失败')
    } else {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([data], { type: 'image/png' }) })])
    }
    return '已复制图片'
  })

  return createPortal(
    <div className="chat-image-overlay" role="dialog" aria-modal="true" aria-label="图片预览" onClick={onClose}>
      <div className="chat-image-viewer" onClick={(event) => event.stopPropagation()}>
        <div className="chat-image-toolbar">
          <span title={alt || src}>{alt || '图片预览'}</span>
          <button onClick={() => void save()} disabled={busy}><Download size={15} />保存</button>
          <button onClick={() => void copyImage()} disabled={busy}><Copy size={15} />复制图片</button>
          <button onClick={() => void copyLink(src, '原图链接')} disabled={busy}><Copy size={15} />复制原图链接</button>
          <a href={src} target="_blank" rel="noreferrer noopener"><ExternalLink size={15} />打开原图链接</a>
          {sourceUrl && sourceUrl !== src && <a href={sourceUrl} target="_blank" rel="noreferrer noopener">查看来源网页</a>}
          <button className="chat-image-close" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </div>
        <div className="chat-image-stage"><img src={src} alt={alt || '预览图片'} /></div>
        {(notice || error) && <div className={`chat-image-status${error ? ' error' : ''}`}>{error || <><Check size={14} />{notice}</>}</div>}
      </div>
    </div>, document.body,
  )
}
