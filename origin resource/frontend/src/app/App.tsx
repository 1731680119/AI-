import { PanelLeftOpen, X } from 'lucide-react'
import { useStore } from '../store'
import { Sidebar } from '../components/layout/Sidebar'
import { MessageList } from '../features/chat/components/MessageList'
import { Composer } from '../features/chat/components/Composer'
import { ExportMenu } from '../features/chat/components/ExportMenu'
import { CodeExecConfirm } from '../features/chat/components/CodeExecConfirm'
import { ArtifactPanel } from '../features/artifacts/components/ArtifactPanel'
import { SettingsModal } from '../features/settings/components/SettingsModal'
import { ImagePage } from '../features/images/components/ImagePage'
import { ProjectModal } from '../features/projects/components/ProjectModal'
import { useInitializeApp } from './useInitializeApp'

/** 应用外壳：只组合全局布局和功能页面，不在这里实现具体业务。 */
export default function App() {
  useInitializeApp()
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const setSidebarOpen = useStore((s) => s.setSidebarOpen)
  const currentId = useStore((s) => s.currentId)
  const conversations = useStore((s) => s.conversations)
  const artifact = useStore((s) => s.artifact)
  const error = useStore((s) => s.error)
  const setError = useStore((s) => s.setError)
  const mode = useStore((s) => s.mode)
  const images = useStore((s) => s.images)
  const selectedImageId = useStore((s) => s.selectedImageId)
  const contextNotice = useStore((s) => s.contextNotice)
  const setContextNotice = useStore((s) => s.setContextNotice)

  const chatTitle = conversations.find((c) => c.id === currentId)?.title
  const imageTitle = images.find((r) => r.id === selectedImageId)?.prompt
  const title = mode === 'image' ? (imageTitle || '图片生成') : (chatTitle || '新对话')

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <div className="topbar">
          {!sidebarOpen && (
            <button className="icon-btn" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
              <PanelLeftOpen size={17} />
            </button>
          )}
          <span className="topbar-title">{title}</span>
          {mode === 'chat' && <ExportMenu />}
        </div>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="icon-btn" onClick={() => setError(null)}><X size={14} /></button>
          </div>
        )}

        {mode === 'chat' && contextNotice && (
          <div className="context-banner">
            <span>
              {contextNotice.error
                ? `上下文压缩未成功：${contextNotice.error}`
                : `对话较长，已把前 ${contextNotice.dropped_messages} 条历史压缩成摘要`
                  + `（约 ${Math.round(contextNotice.before_chars / 1000)}k → ${Math.round(contextNotice.after_chars / 1000)}k 字）`}
            </span>
            <button className="icon-btn" onClick={() => setContextNotice(null)}><X size={14} /></button>
          </div>
        )}

        {mode === 'image' ? (
          <ImagePage />
        ) : (
          <div className={`content-row ${artifact ? 'with-artifact' : ''}`}>
            <div className="chat-column">
              <MessageList />
              <Composer />
            </div>
            <ArtifactPanel />
          </div>
        )}
      </main>
      <SettingsModal />
      <ProjectModal />
      {/* 挂在图片模式之外：确认框在任何界面下都必须弹出来，后端正等着答复。 */}
      <CodeExecConfirm />
    </div>
  )
}
