import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../../../store'

/** 项目新建/编辑弹窗。projectEditing 为 'new' 时是新建，否则是改已有项目。 */
export function ProjectModal() {
  const projectEditing = useStore((s) => s.projectEditing)
  const setProjectEditing = useStore((s) => s.setProjectEditing)
  const projects = useStore((s) => s.projects)
  const saveProject = useStore((s) => s.saveProject)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!projectEditing) return
    const p = projectEditing === 'new' ? null : projects.find((x) => x.id === projectEditing)
    setName(p?.name || '')
    setDescription(p?.description || '')
    setInstructions(p?.instructions || '')
  }, [projectEditing, projects])

  if (!projectEditing) return null

  const close = () => setProjectEditing(null)

  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await saveProject(projectEditing === 'new' ? null : projectEditing, {
        name: name.trim(),
        description: description.trim(),
        instructions,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal modal-sm">
        <div className="modal-header">
          <h2>{projectEditing === 'new' ? '新建项目' : '编辑项目'}</h2>
          <button className="icon-btn" onClick={close}><X size={17} /></button>
        </div>

        <div className="modal-body">
          <div className="field">
            <label>项目名称</label>
            <input
              autoFocus
              value={name}
              placeholder="如：毕业论文"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />
          </div>

          <div className="field">
            <label>项目说明</label>
            <input
              value={description}
              placeholder="仅用于自己辨认，不会发给模型"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="field">
            <label>项目指令</label>
            <textarea
              rows={8}
              value={instructions}
              placeholder="这个项目里的所有对话都会带上这段指令，例如背景资料、术语约定、回答格式要求"
              onChange={(e) => setInstructions(e.target.value)}
            />
            <div className="hint">
              附加在全局系统提示词之后，每轮对话都会发送，写得越长每次消耗越多。
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-ghost" onClick={close}>取消</button>
          <button className="btn-primary" disabled={saving || !name.trim()} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
