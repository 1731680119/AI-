import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check, ChevronDown, ChevronLeft, ChevronRight, Copy, CornerDownRight,
  Loader2, Pencil, RefreshCw, Sparkles,
} from 'lucide-react'
import { AttachmentIcon } from '../attachmentIcon'
import { useStore } from '../../../store'
import { Markdown } from './Markdown'
import { ToolCallBlock } from './ToolCallBlock'
import { activePathOf } from '../exportConversation'
import type { Message } from '../../../types'

/** 从消息树推导当前激活路径（实现与导出共用）。 */
function useActivePath(): Message[] {
  const tree = useStore((s) => s.tree)
  return useMemo(() => activePathOf(tree), [tree])
}

/** 分支导航：同一 parent 下的同角色兄弟节点 */
function BranchNav({ msg }: { msg: Message }) {
  const tree = useStore((s) => s.tree)
  const switchBranch = useStore((s) => s.switchBranch)
  const streaming = useStore((s) => s.streaming)
  if (!tree) return null
  const siblings = tree.messages
    .filter((m) => m.parent_id === msg.parent_id && m.role === msg.role && !m.id.startsWith('temp-'))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  if (siblings.length < 2) return null
  const idx = siblings.findIndex((m) => m.id === msg.id)
  return (
    <span className="branch-nav">
      <button
        disabled={idx <= 0 || streaming}
        onClick={() => switchBranch(siblings[idx - 1].id)}
      >
        <ChevronLeft size={13} />
      </button>
      <span>{idx + 1} / {siblings.length}</span>
      <button
        disabled={idx >= siblings.length - 1 || streaming}
        onClick={() => switchBranch(siblings[idx + 1].id)}
      >
        <ChevronRight size={13} />
      </button>
    </span>
  )
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      title="复制"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          useStore.getState().setError('复制失败，请选中文字后按 Ctrl+C 复制')
        }
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

function ThinkingBlock({ msg }: { msg: Message }) {
  const [open, setOpen] = useState(false)
  const isThinking = !!msg.streaming && !!msg.thinkingOpen
  const show = isThinking || open
  if (!msg.thinking) return null
  return (
    <div className="thinking-block">
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
        {isThinking ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
        {isThinking ? '正在思考…' : '思考过程'}
        <ChevronDown size={13} style={{ transform: show ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      {show && <div className="thinking-body">{msg.thinking}</div>}
    </div>
  )
}

function UserMessage({ msg }: { msg: Message }) {
  const sendMessage = useStore((s) => s.sendMessage)
  const streaming = useStore((s) => s.streaming)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const submitEdit = () => {
    if (streaming || (!draft.trim() && !msg.attachments?.length)) return
    setEditing(false)
    // 编辑重发：以原消息的 parent 为父节点新建分支
    sendMessage(draft, msg.attachments || [], { parentId: msg.parent_id })
  }

  if (editing) {
    return (
      <div className="msg-row user">
        <div className="user-bubble editing">
          <textarea
            autoFocus
            value={draft}
            rows={Math.min(10, draft.split('\n').length + 1)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submitEdit()
              }
              if (e.key === 'Escape') setEditing(false)
            }}
          />
          <div className="edit-actions">
            <button className="btn-ghost" onClick={() => setEditing(false)}>取消</button>
            <button className="btn-primary" onClick={submitEdit}>发送</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="msg-row user">
      <div className="user-col">
        {msg.attachments?.length > 0 && (
          <div className="attach-list in-msg">
            {msg.attachments.map((a) => (
              <div className="attach-card" key={a.id}>
                {a.kind === 'image' && a.preview ? (
                  <img src={a.preview} alt={a.name} />
                ) : (
                  <AttachmentIcon kind={a.kind} size={15} />
                )}
                <span className="name">{a.name}</span>
              </div>
            ))}
          </div>
        )}
        {msg.content && <div className="user-bubble">{msg.content}</div>}
        <div className="msg-actions">
          <BranchNav msg={msg} />
          <CopyAction text={msg.content} />
          {!msg.id.startsWith('temp-') && (
            <button
              title="编辑"
              disabled={streaming}
              onClick={() => {
                setDraft(msg.content)
                setEditing(true)
              }}
            >
              <Pencil size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function AssistantMessage({ msg, isLast }: { msg: Message; isLast: boolean }) {
  const sendMessage = useStore((s) => s.sendMessage)
  const streaming = useStore((s) => s.streaming)
  return (
    <div className="msg-row assistant">
      <div className="assistant-block">
        <ThinkingBlock msg={msg} />
        {msg.tool_calls?.map((call) => (
          <ToolCallBlock key={call.call_id} call={call} />
        ))}
        {msg.content ? (
          <>
            <Markdown content={msg.content} messageId={msg.id} />
            {msg.streaming && <span className="stream-cursor" />}
          </>
        ) : (
          // 工具正在跑时它自己的气泡已经在转圈了，再加一行「正在生成」会重复。
          msg.streaming && !msg.thinking && !msg.tool_calls?.length && (
            <div className="typing-hint">
              <Loader2 size={14} className="spin" /> 正在生成…
            </div>
          )
        )}
        {!msg.streaming && (
          <div className="msg-actions">
            <BranchNav msg={msg} />
            <CopyAction text={msg.content} />
            {!msg.id.startsWith('temp-') && (
              <>
                <button
                  title="重新生成"
                  disabled={streaming}
                  onClick={() => sendMessage('', [], { regenerateFrom: msg.id })}
                >
                  <RefreshCw size={13} />
                </button>
                {isLast && msg.content && (
                  <button
                    title="继续生成（接着写完，不另起一条）"
                    disabled={streaming}
                    onClick={() => sendMessage('', [], { continueFrom: msg.id })}
                  >
                    <CornerDownRight size={13} />
                  </button>
                )}
              </>
            )}
            {msg.model && <span className="model-tag">{msg.model}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function Welcome() {
  const hour = new Date().getHours()
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  return (
    <div className="welcome">
      <div className="welcome-logo">✳</div>
      <h1>{greeting}，有什么可以帮你的？</h1>
    </div>
  )
}

/** 根据当前激活分支渲染消息，并负责流式回答期间的跟随滚动。 */
export function MessageList() {
  const path = useActivePath()
  const currentId = useStore((s) => s.currentId)
  const streaming = useStore((s) => s.streaming)
  const loading = useStore((s) => !!s.currentId && !s.tree)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  // 流式输出时自动滚动到底部（用户上滚则暂停）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight
  }, [path, streaming])

  // 切换会话时滚到底
  useEffect(() => {
    stickBottom.current = true
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [currentId])

  if (loading) {
    return <div className="messages" ref={scrollRef}><div className="typing-hint" role="status"><Loader2 size={14} className="spin" /> 正在加载对话…</div></div>
  }

  if (!currentId || path.length === 0) {
    return (
      <div className="messages" ref={scrollRef}>
        <Welcome />
      </div>
    )
  }

  return (
    <div className="messages" ref={scrollRef}>
      <div className="messages-inner">
        {path.map((m, i) =>
          m.role === 'user'
            ? <UserMessage key={m.id} msg={m} />
            : <AssistantMessage key={m.id} msg={m} isLast={i === path.length - 1} />,
        )}
      </div>
    </div>
  )
}
