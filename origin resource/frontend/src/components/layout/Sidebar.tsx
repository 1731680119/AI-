import { useEffect, useState } from 'react'
import { Search, MessageSquarePlus, Pencil, Trash2, Settings as SettingsIcon, Import, PanelLeftClose, MessageSquare, Palette, ImagePlus, FolderPlus, Folder, FolderOpen } from 'lucide-react'
import { useStore } from '../../store'
import { migrateOldData, migrateOldImages, imageFileUrl, searchConversations } from '../../services/api'
import type { MessageSearchHit } from '../../types'

/** 左侧导航：统一管理聊天历史、图片历史和两个模式之间的切换。 */
export function Sidebar() {
  const { conversations, currentId, sidebarOpen, mode, images, selectedImageId } = useStore()
  const selectConversation = useStore((s) => s.selectConversation)
  const newConversation = useStore((s) => s.newConversation)
  const removeConversation = useStore((s) => s.removeConversation)
  const rename = useStore((s) => s.rename)
  const setSidebarOpen = useStore((s) => s.setSidebarOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const loadConversations = useStore((s) => s.loadConversations)
  const setMode = useStore((s) => s.setMode)
  const selectImage = useStore((s) => s.selectImage)
  const newImageDraft = useStore((s) => s.newImageDraft)
  const removeImage = useStore((s) => s.removeImage)
  const loadImages = useStore((s) => s.loadImages)

  const projects = useStore((s) => s.projects)
  const projectFilter = useStore((s) => s.projectFilter)
  const setProjectFilter = useStore((s) => s.setProjectFilter)
  const setProjectEditing = useStore((s) => s.setProjectEditing)
  const removeProject = useStore((s) => s.removeProject)

  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [migrating, setMigrating] = useState(false)

  // 项目筛选和标题搜索叠加：选中项目后搜索只在该项目内进行。
  const byProject = projectFilter
    ? conversations.filter((c) => c.project_id === projectFilter)
    : conversations
  const filtered = query
    ? byProject.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
    : byProject

  // 正文搜索走后端（正文不在前端），标题命中的会话不再重复列一遍。
  const [bodyHits, setBodyHits] = useState<MessageSearchHit[]>([])
  useEffect(() => {
    const q = query.trim()
    if (mode !== 'chat' || q.length < 2) {
      setBodyHits([])
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      searchConversations(q)
        .then((hits) => alive && setBodyHits(hits))
        .catch(() => alive && setBodyHits([]))
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, mode])

  const titleIds = new Set(filtered.map((c) => c.id))
  const extraHits = bodyHits.filter(
    (h) => !titleIds.has(h.conversation_id)
      && (!projectFilter || h.project_id === projectFilter),
  )

  const commitRename = async () => {
    if (editingId && editTitle.trim()) {
      await rename(editingId, editTitle.trim())
    }
    setEditingId(null)
  }

  const handleMigrate = async () => {
    if (migrating) return
    setMigrating(true)
    try {
      if (mode === 'image') {
        const r = await migrateOldImages()
        await loadImages()
        alert(`成功导入 ${r.imported} 条图片记录`)
      } else {
        const r = await migrateOldData()
        await loadConversations()
        alert(`成功导入 ${r.imported} 个历史会话`)
      }
    } catch (e) {
      alert(`迁移失败：${(e as Error).message}`)
    } finally {
      setMigrating(false)
    }
  }

  const filteredImages = query
    ? images.filter((r) => r.prompt.toLowerCase().includes(query.toLowerCase()))
    : images

  return (
    <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <span className="dot" />
          AI 助手
        </div>
        <button className="icon-btn" title="收起侧栏" onClick={() => setSidebarOpen(false)}>
          <PanelLeftClose size={17} />
        </button>
      </div>

      <div className="mode-switch">
        <button
          className={mode === 'chat' ? 'active' : ''}
          onClick={() => setMode('chat')}
        >
          <MessageSquare size={14} />
          对话
        </button>
        <button
          className={mode === 'image' ? 'active' : ''}
          onClick={() => setMode('image')}
        >
          <Palette size={14} />
          图片
        </button>
      </div>

      {mode === 'chat' ? (
        <button className="new-chat-btn" onClick={newConversation}>
          <MessageSquarePlus size={16} />
          新建对话
        </button>
      ) : (
        <button className="new-chat-btn" onClick={newImageDraft}>
          <ImagePlus size={16} />
          新建图片
        </button>
      )}

      {mode === 'chat' && (
        <div className="project-section">
          <div className="project-section-head">
            <span>项目</span>
            <button className="icon-btn" title="新建项目" onClick={() => setProjectEditing('new')}>
              <FolderPlus size={14} />
            </button>
          </div>
          {projects.length === 0 ? (
            <div className="project-empty">用项目给一组对话配专属指令</div>
          ) : (
            <div className="project-list">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`project-item ${p.id === projectFilter ? 'active' : ''}`}
                  onClick={() => setProjectFilter(p.id === projectFilter ? null : p.id)}
                >
                  {p.id === projectFilter ? <FolderOpen size={13} /> : <Folder size={13} />}
                  <span className="title">{p.name}</span>
                  <span className="count">{p.conversation_count ?? 0}</span>
                  <span className="actions">
                    <button
                      title="编辑项目"
                      onClick={(e) => {
                        e.stopPropagation()
                        setProjectEditing(p.id)
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      title="删除项目"
                      onClick={(e) => {
                        e.stopPropagation()
                        // 会话本身保留，只是不再属于任何项目，先说清楚再删。
                        if (confirm(`删除项目「${p.name}」？其中的对话会保留，但不再套用项目指令。`)) {
                          removeProject(p.id)
                        }
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="sidebar-search">
        <Search size={14} />
        <input
          placeholder={mode === 'chat' ? '搜索对话…' : '搜索图片提示词…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {mode === 'chat' ? (
      <div className="conv-list">
        {filtered.map((c) => (
          <div
            key={c.id}
            className={`conv-item ${c.id === currentId ? 'active' : ''}`}
            onClick={() => editingId !== c.id && selectConversation(c.id)}
          >
            {editingId === c.id ? (
              <input
                autoFocus
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span className="title">{c.title}</span>
                <span className="actions">
                  <button
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingId(c.id)
                      setEditTitle(c.title)
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirm(`删除对话「${c.title}」？`)) removeConversation(c.id)
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </>
            )}
          </div>
        ))}
        {extraHits.length > 0 && (
          <>
            <div className="conv-group-head">正文匹配</div>
            {extraHits.map((h) => (
              <div
                key={h.conversation_id}
                className={`conv-item hit ${h.conversation_id === currentId ? 'active' : ''}`}
                onClick={() => selectConversation(h.conversation_id)}
                title={h.snippet}
              >
                <span className="hit-body">
                  <span className="title">{h.title}</span>
                  <span className="hit-snippet">{h.snippet}</span>
                </span>
                {h.match_count > 1 && <span className="count">{h.match_count}</span>}
              </div>
            ))}
          </>
        )}
        {filtered.length === 0 && extraHits.length === 0 && (
          <div style={{ padding: '20px 10px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            {query
              ? '未找到匹配的对话'
              : projectFilter ? '这个项目下还没有对话' : '暂无对话，开始新对话吧'}
          </div>
        )}
      </div>
      ) : (
      <div className="conv-list">
        {filteredImages.map((r) => (
          <div
            key={r.id}
            className={`conv-item image-item ${r.id === selectedImageId ? 'active' : ''}`}
            onClick={() => selectImage(r.id)}
          >
            {r.files[0] && (
              <img className="thumb" src={imageFileUrl(r.files[0])} alt="" loading="lazy" />
            )}
            <span className="title">
              {r.prompt || (r.mode === 'edit' ? '图片编辑' : '图片生成')}
            </span>
            <span className="actions">
              <button
                title="删除"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm('删除这条图片记录？')) removeImage(r.id)
                }}
              >
                <Trash2 size={13} />
              </button>
            </span>
          </div>
        ))}
        {filteredImages.length === 0 && (
          <div style={{ padding: '20px 10px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            {query ? '未找到匹配的记录' : '暂无图片，去生成一张吧'}
          </div>
        )}
      </div>
      )}

      <div className="sidebar-footer">
        <button onClick={handleMigrate} disabled={migrating} title={mode === 'chat' ? '从旧版 chat_data.json 导入' : '从旧版 generated_images 导入'}>
          <Import size={14} />
          {migrating ? '导入中…' : '导入旧数据'}
        </button>
        <button onClick={() => setSettingsOpen(true)}>
          <SettingsIcon size={14} />
          设置
        </button>
      </div>
    </aside>
  )
}
