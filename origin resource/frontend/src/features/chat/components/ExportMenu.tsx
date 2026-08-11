import { useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { useStore } from '../../../store'
import { exportConversation } from '../exportConversation'

/** 顶栏的导出入口：Markdown 只含当前分支，JSON 含完整消息树。 */
export function ExportMenu() {
  const tree = useStore((s) => s.tree)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!tree || !tree.messages.length) return null

  const pick = (format: 'md' | 'json') => {
    exportConversation(tree, format)
    setOpen(false)
  }

  return (
    <div className="model-select export-select" ref={ref}>
      <button className="icon-btn" title="导出对话" onClick={() => setOpen((v) => !v)}>
        <Download size={17} />
      </button>
      {open && (
        <div className="model-menu">
          <div className="model-item" onClick={() => pick('md')}>
            <span>导出 Markdown</span>
          </div>
          <div className="model-item" onClick={() => pick('json')}>
            <span>导出 JSON（含分支）</span>
          </div>
        </div>
      )}
    </div>
  )
}
