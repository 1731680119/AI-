import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  clearMemories,
  createMemory,
  deleteMemory,
  listMemories,
  updateMemory,
} from '../../../services/api'
import type { Memory } from '../../../types'

/** 记忆列表直接读写后端，不走设置的 draft：增删应当立刻生效，等保存反而更容易误解。 */
export function MemoryPanel({ enabled }: { enabled: boolean }) {
  const [items, setItems] = useState<Memory[]>([])
  const [blockChars, setBlockChars] = useState(0)
  const [draftText, setDraftText] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const reload = async () => {
    try {
      const data = await listMemories()
      setItems(data.items)
      setBlockChars(data.block_chars)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [])

  const add = async () => {
    const content = draftText.trim()
    if (!content) return
    try {
      const res = await createMemory(content)
      setDraftText('')
      if (res.duplicate) setError('这条记忆已经存在，未重复添加')
      else setError('')
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const saveEdit = async () => {
    if (!editing) return
    const content = editing.text.trim()
    if (!content) return
    try {
      await updateMemory(editing.id, content)
      setEditing(null)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const remove = async (id: string) => {
    try {
      await deleteMemory(id)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const clearAll = async () => {
    if (!confirm(`确定清空全部 ${items.length} 条记忆？此操作无法撤销。`)) return
    try {
      await clearMemories()
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="field">
      <label>已记住的信息{items.length > 0 && `（${items.length} 条）`}</label>

      {error && <div className="memory-error">{error}</div>}

      <div className="memory-list">
        {loading ? (
          <div className="memory-empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="memory-empty">
            还没有记忆。对话里让我记住某件事，或者在下面手工添加。
          </div>
        ) : (
          items.map((m) => (
            <div className="memory-row" key={m.id}>
              {editing?.id === m.id ? (
                <textarea
                  className="memory-edit"
                  rows={2}
                  autoFocus
                  value={editing.text}
                  onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                  onBlur={saveEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void saveEdit()
                    }
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <span
                  className="memory-text"
                  title="点击编辑"
                  onClick={() => setEditing({ id: m.id, text: m.content })}
                >
                  {m.content}
                </span>
              )}
              <button className="icon-btn" title="删除这条记忆" onClick={() => remove(m.id)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}

        <div className="model-add">
          <input
            value={draftText}
            placeholder="手工添加一条，如「我叫小林，偏好简洁回答」"
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn-ghost" onClick={add}><Plus size={14} /> 添加</button>
        </div>
      </div>

      <div className="memory-foot">
        <span className="hint">
          {enabled
            ? `这些内容每轮都会随请求发送，当前约 ${blockChars} 字符，已计入上下文预算`
            : '记忆已关闭，下面的内容会保留但不会发送给模型'}
        </span>
        {items.length > 0 && (
          <button className="link-danger" onClick={clearAll}>清空全部</button>
        )}
      </div>
    </div>
  )
}
