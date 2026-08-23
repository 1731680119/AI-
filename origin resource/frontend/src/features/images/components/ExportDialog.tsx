import { useEffect, useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import * as api from '../../../services/api'
import type { ExportFormat } from '../../../services/api'
import { imageFileUrl } from '../../../services/api'

/**
 * 桌面端的保存能力。浏览器里没有这个桥，会退回 `<a download>`，
 * 由浏览器自己决定存到哪儿。
 */
const desktop = () => (window as unknown as {
  chatbotDesktop?: {
    saveBinaryFile?: (payload: {
      data: ArrayBuffer
      filename: string
      extension: string
      label: string
    }) => Promise<{ saved: boolean; path?: string; reason?: string }>
  }
}).chatbotDesktop

const TIFF_COMPRESSIONS = [
  { key: 'lzw', label: 'LZW（无损，通用）' },
  { key: 'deflate', label: 'Deflate（无损，体积更小）' },
  { key: 'none', label: '不压缩（体积最大）' },
]

const DPI_PRESETS = [72, 96, 150, 300, 600]

interface Props {
  /** 要导出的图片文件名，即 data/images/ 下的名字。 */
  name: string
  onClose: () => void
}

/** 图片导出对话框：选格式 + 按格式显示可调项，确认后调后端转换再落盘。 */
export function ExportDialog({ name, onClose }: Props) {
  const [formats, setFormats] = useState<ExportFormat[]>([])
  const [formatKey, setFormatKey] = useState('png')
  const [quality, setQuality] = useState(92)
  const [compression, setCompression] = useState('lzw')
  const [dpi, setDpi] = useState(300)
  const [background, setBackground] = useState('#FFFFFF')
  // 空字符串表示「保持原尺寸」。只填一边时另一边由后端按原比例推算。
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [source, setSource] = useState<{ w: number; h: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void api.listExportFormats()
      .then((data) => {
        if (!alive) return
        setFormats(data.formats)
        // 后端探测不出 PNG 基本不可能，但真出了这种事也别让下拉是空的。
        if (data.formats.length && !data.formats.some((item) => item.key === 'png')) {
          setFormatKey(data.formats[0].key)
        }
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [])

  // 原图尺寸只用来当宽高输入框的占位提示，拉不到就留空，不影响导出。
  useEffect(() => {
    let alive = true
    const probe = new Image()
    probe.onload = () => { if (alive) setSource({ w: probe.naturalWidth, h: probe.naturalHeight }) }
    probe.src = imageFileUrl(name)
    return () => { alive = false }
  }, [name])

  const format = useMemo(
    () => formats.find((item) => item.key === formatKey) ?? null,
    [formats, formatKey],
  )

  const toNumber = (value: string): number | null => {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }

  const run = async () => {
    if (!format || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await api.exportImage({
        name,
        format: format.key,
        quality,
        tiff_compression: compression,
        dpi,
        background,
        width: toNumber(width),
        height: toNumber(height),
      })
      const filename = result.filename || `${name}.${format.ext}`
      const bridge = desktop()
      if (bridge?.saveBinaryFile) {
        const saved = await bridge.saveBinaryFile({
          data: await result.blob.arrayBuffer(),
          filename,
          extension: format.ext,
          label: format.label,
        })
        if (saved.saved) {
          setNotice(`已保存到 ${saved.path}`)
        } else if (saved.reason !== 'canceled') {
          setError(`保存失败：${saved.reason}`)
        }
      } else {
        const url = URL.createObjectURL(result.blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        link.click()
        URL.revokeObjectURL(url)
        setNotice(`已导出 ${filename}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm image-export" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>导出图片</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="field">
            <label>目标格式</label>
            <select value={formatKey} onChange={(e) => setFormatKey(e.target.value)}>
              {formats.map((item) => (
                <option key={item.key} value={item.key}>{item.label}</option>
              ))}
            </select>
            {format && <p className="hint">{format.note}</p>}
            {formats.length === 0 && !error && <p className="hint">正在读取可用格式…</p>}
          </div>

          {format?.quality && (
            <div className="field">
              <label>质量：{quality}{format.key === 'webp' && quality >= 100 ? '（无损）' : ''}</label>
              <input
                type="range"
                min={1}
                max={100}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
              />
              <p className="hint">数值越高越清晰、文件越大。90 以上肉眼基本看不出差别。</p>
            </div>
          )}

          {format?.compression && (
            <div className="field">
              <label>压缩方式</label>
              <select value={compression} onChange={(e) => setCompression(e.target.value)}>
                {TIFF_COMPRESSIONS.map((item) => (
                  <option key={item.key} value={item.key}>{item.label}</option>
                ))}
              </select>
              <p className="hint">三种都是无损的，只影响文件大小和兼容性。</p>
            </div>
          )}

          {format?.dpi && (
            <div className="field">
              <label>DPI（打印分辨率）</label>
              <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
                {DPI_PRESETS.map((item) => (
                  <option key={item} value={item}>
                    {item}{item === 300 ? '（印刷常用）' : item === 96 ? '（屏幕）' : ''}
                  </option>
                ))}
              </select>
              <p className="hint">只写进文件元数据，不改变像素数量。</p>
            </div>
          )}

          {format && !format.alpha && (
            <div className="field export-bg">
              <label>透明区域填充色</label>
              <div className="export-bg-row">
                <input
                  type="color"
                  value={background}
                  onChange={(e) => setBackground(e.target.value.toUpperCase())}
                />
                <span>{background}</span>
              </div>
              <p className="hint">{format.label} 不支持透明，原图的透明部分会被填成这个颜色。</p>
            </div>
          )}

          <div className="field-row">
            <div className="field">
              <label>宽度（像素）</label>
              <input
                type="number"
                min={1}
                placeholder={source ? String(source.w) : '保持原尺寸'}
                value={width}
                onChange={(e) => setWidth(e.target.value)}
              />
            </div>
            <div className="field">
              <label>高度（像素）</label>
              <input
                type="number"
                min={1}
                placeholder={source ? String(source.h) : '保持原尺寸'}
                value={height}
                onChange={(e) => setHeight(e.target.value)}
              />
            </div>
          </div>
          <p className="hint">
            两边都留空即保持原尺寸；只填一边，另一边按原比例自动计算。
            {format?.key === 'ico' && ' ICO 的边长上限是 256，超出会被自动缩小。'}
          </p>

          {error && <p className="export-error">{error}</p>}
          {notice && <p className="export-notice">{notice}</p>}
        </div>

        <div className="modal-footer">
          <span className="export-source">{source ? `原图 ${source.w} × ${source.h}` : ''}</span>
          <div className="right">
            <button className="btn btn-ghost" onClick={onClose}>关闭</button>
            <button className="btn btn-primary" disabled={!format || busy} onClick={run}>
              {busy ? <><Loader2 size={14} className="spin" />转换中…</> : '导出'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
