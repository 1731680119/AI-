import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp, Bookmark, Brain, Check, ChevronDown, LayoutTemplate, Paperclip, Square, X, Palette,
} from 'lucide-react'
import { AttachmentIcon } from '../attachmentIcon'
import { useStore } from '../../../store'
import { uploadFile } from '../../../services/api'
import { useFileDrop } from '../../../hooks/useFileDrop'
import { useSortableList } from '../../../hooks/useSortableList'
import { useDesktopChannels, groupByChannel, resolveChannelName } from '../../../hooks/useDesktopChannels'

const THINKING_OPTIONS = ['auto', 'minimal', 'low', 'medium', 'high'] as const
const THINKING_LABELS: Record<string, string> = {
  auto: '自动',
  minimal: '极简',
  low: '简短',
  medium: '中等',
  high: '深入',
}

/** 聊天输入区：收集文字与附件，键盘和按钮最终都调用 Store 的 sendMessage。 */
export function Composer() {
  const settings = useStore((s) => s.settings)
  const streaming = useStore((s) => s.streaming)
  const sendMessage = useStore((s) => s.sendMessage)
  const stopStreaming = useStore((s) => s.stopStreaming)
  const saveSettings = useStore((s) => s.saveSettings)
  const tree = useStore((s) => s.tree)
  const pending = useStore((s) => s.pending)
  const assignStyle = useStore((s) => s.assignStyle)
  const assignMemory = useStore((s) => s.assignMemory)
  const memories = useStore((s) => s.memories)
  const loadMemories = useStore((s) => s.loadMemories)
  const thinkingLevel = useStore((s) => s.thinkingLevel)
  const setThinkingLevel = useStore((s) => s.setThinkingLevel)
  const chatApiId = useStore((s) => s.chatApiId)
  const setChatApiId = useStore((s) => s.setChatApiId)
  const draftKey = useStore((s) => s.currentId) || 'new'
  const draft = useStore((s) => s.chatDrafts[draftKey])
  const patchChatDraft = useStore((s) => s.patchChatDraft)
  const text = draft?.text || ''
  const attachments = draft?.attachments || []
  const setText = (value: string) => patchChatDraft(draftKey, { text: value })
  const [uploading, setUploading] = useState(false)
  const uploadLock = useRef(false)
  const [modelMenu, setModelMenu] = useState(false)
  const [styleMenu, setStyleMenu] = useState(false)
  const [tplMenu, setTplMenu] = useState(false)
  const [thinkMenu, setThinkMenu] = useState(false)
  const [memoryMenu, setMemoryMenu] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const styleRef = useRef<HTMLDivElement>(null)
  const tplRef = useRef<HTMLDivElement>(null)
  const thinkRef = useRef<HTMLDivElement>(null)
  const memoryRef = useRef<HTMLDivElement>(null)

  // 自动伸缩输入框高度
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'
  }, [text])

  // 点击外部关闭模型菜单
  useEffect(() => {
    if (!modelMenu) return
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setModelMenu(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [modelMenu])

  useEffect(() => {
    if (!styleMenu) return
    const onClick = (e: MouseEvent) => {
      if (styleRef.current && !styleRef.current.contains(e.target as Node)) setStyleMenu(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [styleMenu])

  useEffect(() => {
    if (!tplMenu) return
    const onClick = (e: MouseEvent) => {
      if (tplRef.current && !tplRef.current.contains(e.target as Node)) setTplMenu(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [tplMenu])

  useEffect(() => {
    if (!thinkMenu) return
    const onClick = (e: MouseEvent) => {
      if (thinkRef.current && !thinkRef.current.contains(e.target as Node)) setThinkMenu(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [thinkMenu])

  useEffect(() => {
    if (!memoryMenu) return
    const onClick = (e: MouseEvent) => {
      if (memoryRef.current && !memoryRef.current.contains(e.target as Node)) setMemoryMenu(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [memoryMenu])

  const canSend = !!settings && (text.trim() || attachments.length > 0) && !streaming && !uploading

  const doSend = async () => {
    if (!canSend) return
    const content = text
    const atts = attachments
    const accepted = await sendMessage(content, atts)
    if (accepted) {
      // 清除实际发送的那份草稿，切到其他会话后不能误清新输入。
      const current = useStore.getState().chatDrafts[draftKey]
      if (current?.text === content && current.attachments === atts) {
        patchChatDraft(draftKey, { text: '', attachments: [] })
      }
    }
    taRef.current?.focus()
  }

  const handleFiles = async (files: FileList | File[]) => {
    if (uploadLock.current || useStore.getState().streaming) return
    uploadLock.current = true
    // 先按设置里的体积上限做本地拦截，避免把明显超限的文件传给后端再被拒绝。
    const singleMaxMb = settings?.single_file_max_mb ?? 20
    const totalMaxMb = settings?.message_files_max_mb ?? 30
    const singleMaxBytes = singleMaxMb * 1024 * 1024
    const totalMaxBytes = totalMaxMb * 1024 * 1024
    let usedBytes = attachments.reduce((sum, a) => sum + (a.size || 0), 0)

    setUploading(true)
    try {
      for (const f of Array.from(files)) {
        if (f.size > singleMaxBytes) {
          useStore.getState().setError(
            `「${f.name}」约 ${(f.size / 1024 / 1024).toFixed(1)}MB，超过单个附件 ${singleMaxMb}MB 上限，可在设置中调整`,
          )
          continue
        }
        if (usedBytes + f.size > totalMaxBytes) {
          useStore.getState().setError(
            `本条消息附件合计已接近 ${totalMaxMb}MB 上限，「${f.name}」未添加，可在设置中调整`,
          )
          continue
        }
        try {
          const att = await uploadFile(f)
          usedBytes += att.size || f.size
          const existing = useStore.getState().chatDrafts[draftKey]?.attachments || []
          patchChatDraft(draftKey, { attachments: [...existing, att] })
        } catch (e) {
          useStore.getState().setError(`「${f.name}」上传失败：${(e as Error).message}`)
        }
      }
    } catch (e) {
      useStore.getState().setError(`上传失败：${(e as Error).message}`)
    } finally {
      uploadLock.current = false
      setUploading(false)
    }
  }

  const templates = settings?.prompt_templates || []

  // 拖进来的文件走和回形针按钮完全相同的一套：体积上限、错误提示、上传中状态都复用。
  // 类型不过滤——后端支持的格式远不止图片，交给 handleFiles/后端判断。
  const { dragging, dropProps } = useFileDrop({
    disabled: streaming || uploading,
    onFiles: handleFiles,
  })

  /** 模板只填进输入框，发不发由用户定；{{input}} 用已经打好的字替换。 */
  const applyTemplate = (content: string) => {
    const current = text.trim()
    const filled = content.includes('{{input}}')
      ? content.split('{{input}}').join(current)
      : current ? `${content}\n\n${current}` : content
    setText(filled)
    setTplMenu(false)
    taRef.current?.focus()
  }

  const model = settings?.default_model || ''
  const models = settings?.models || []

  /**
   * 模型菜单里的拖动排序。
   *
   * 只在「没有渠道模型清单」这条退路上生效（浏览器里，或者用户一家都没点过
   * 「获取模型清单」）。顺序直接写回 `settings.models`——那个数组本来就是
   * 「我关注的模型」的清单，它的顺序只影响这个菜单怎么排。
   */
  const modelSort = useSortableList(models.length, (from, to) => {
    if (!settings) return
    const next = [...models]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    void saveSettings({ models: next }).catch((e) => useStore.getState().setError(`保存模型顺序失败：${e.message}`))
  })

  // 桌面端按渠道分组列模型：A 家的 GPT 和 B 家的 GPT 是两个可选项，
  // 选中时连渠道 id 一起记下来，请求就只发给这一家。
  const { supported: channelsSupported, channels, refresh: refreshChannels } = useDesktopChannels()
  const chatGroups = groupByChannel(channels, 'chat')
  const grouped = channelsSupported && chatGroups.length > 0
  // 刚进软件时 chatApiId 还是 null，但请求照样发得出去（主进程会兜底挑一家）。
  // 所以这里按同一套优先级把那家算出来显示，别让渠道名空着。
  const activeChannelName = resolveChannelName(chatGroups, chatApiId, model)

  const openModelMenu = () => {
    // 每次打开都重新拉：渠道的模型清单可能刚在设置页里被获取或增删过。
    if (!modelMenu) void refreshChannels()
    setModelMenu((v) => !v)
  }

  /** 选定「某家渠道的某个模型」：模型名进设置（能跨重启），渠道 id 只记本次运行。 */
  const pickModel = (name: string, apiId: string | null) => {
    if (settings && name !== model) void saveSettings({ default_model: name }).catch((e) => useStore.getState().setError(`切换模型失败：${e.message}`))
    setChatApiId(apiId)
    setModelMenu(false)
  }

  // 已有会话读库里的风格，新会话读 pending，都没有就落到默认风格。
  const styles = settings?.styles || []
  const styleId = (tree ? tree.style_id : pending.styleId) || settings?.default_style_id || ''
  const styleName = styles.find((s) => s.id === styleId)?.name || '默认'

  // 本次没选就显示设置里的默认档位，让按钮上的字和实际生效的档位一致。
  const thinking = thinkingLevel || settings?.default_thinking || 'auto'

  // 记忆同样是「已有会话读库、新会话读 pending」。总开关和勾选项分开存：
  // 关掉开关不清空勾选，用户再打开时上次挑的那几条还在。
  const memoryEnabled = tree ? tree.memory_enabled : pending.memoryEnabled
  const memoryIds = (tree ? tree.memory_ids : pending.memoryIds) || []
  const memoryCount = memoryEnabled ? memoryIds.length : 0

  const openMemoryMenu = () => {
    // 每次打开都重新拉：记忆可能刚在设置页里被增删过。
    if (!memoryMenu) void loadMemories()
    setMemoryMenu((v) => !v)
  }

  const toggleMemorySwitch = async () => {
    if (memoryEnabled) {
      await assignMemory(false, memoryIds)
      return
    }
    // 从关到开时如果一条都没勾，默认全选——用户点开关的意思是「这次要用记忆」，
    // 让他先看到效果、再按需取消勾选，比打开后什么都不带更符合预期。
    // 先 await 拉一次列表，否则菜单还没开过时 memories 是空的，会开出一个空开关。
    let ids = memoryIds
    if (!ids.length) {
      await loadMemories()
      ids = useStore.getState().memories.map((m) => m.id)
    }
    await assignMemory(true, ids)
  }

  const toggleMemoryItem = (id: string) => {
    // 以界面上看到的勾选状态为准：开关关着时列表一律显示未勾选，
    // 这时点第一条就该是「只用这一条」，而不是把上次残留的选择反着改一下。
    const base = memoryEnabled ? memoryIds : []
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
    // 勾任意一条即视为打开总开关，省掉「勾了却没生效」这种困惑。
    void assignMemory(next.length > 0, next)
  }

  return (
    <div className="composer-wrap">
      <div className={`composer${dragging ? ' drag-over' : ''}`} {...dropProps}>
        {dragging && <div className="composer-drop-hint">松开即可添加附件</div>}
        {attachments.length > 0 && (
          <div className="attach-list">
            {attachments.map((a) => (
              <div className="attach-card" key={a.id}>
                {a.kind === 'image' && a.preview ? (
                  <img src={a.preview} alt={a.name} />
                ) : (
                  <AttachmentIcon kind={a.kind} size={16} />
                )}
                <span className="name">{a.name}</span>
                <button
                  className="remove"
                  aria-label={`移除附件 ${a.name}`}
                  disabled={streaming || uploading}
                  onClick={() => patchChatDraft(draftKey, { attachments: attachments.filter((x) => x.id !== a.id) })}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          rows={1}
          placeholder="今天我能帮你什么？"
          aria-label="消息输入框"
          value={text}
          spellCheck={false}
          disabled={streaming}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              doSend()
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files)
            if (files.length) {
              e.preventDefault()
              handleFiles(files)
            }
          }}
        />

        <div className="composer-bar">
          <div className="composer-left">
            <button
              className="icon-btn"
              title="上传文件（图片 / PDF / Word / 文本）"
              onClick={() => fileRef.current?.click()}
              disabled={uploading || streaming}
            >
              <Paperclip size={17} />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept="image/*,.pdf,.docx,.xlsx,.xlsm,.pptx,.txt,.md,.rst,.csv,.tsv,.log,.json,.jsonl,.xml,.yaml,.yml,.toml,.ini,.html,.css,.scss,.vue,.svelte,.py,.js,.mjs,.ts,.tsx,.jsx,.java,.kt,.c,.h,.cpp,.cs,.go,.rs,.rb,.php,.swift,.dart,.lua,.sql,.sh,.bat,.ps1"
              onChange={(e) => {
                if (e.target.files?.length) handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
            {templates.length > 0 && (
              <div className="style-select" ref={tplRef}>
                <button
                  className="icon-btn"
                  title="提示词模板"
                  disabled={streaming}
                  onClick={() => setTplMenu((v) => !v)}
                >
                  <LayoutTemplate size={17} />
                </button>
                {tplMenu && (
                  <div className="model-menu">
                    {templates.map((t) => (
                      <div
                        key={t.id}
                        className="model-item"
                        title={t.content}
                        onClick={() => applyTemplate(t.content)}
                      >
                        <span>{t.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="style-select" ref={thinkRef}>
              <button className="style-btn" title="思考档位" onClick={() => setThinkMenu((v) => !v)}>
                <Brain size={15} />
                <span>{THINKING_LABELS[thinking] || '自动'}</span>
              </button>
              {thinkMenu && (
                <div className="model-menu">
                  {THINKING_OPTIONS.map((level) => (
                    <div
                      key={level}
                      className={`model-item ${level === thinking ? 'active' : ''}`}
                      onClick={() => {
                        // auto 存 null，这样以后改了设置里的默认档位能跟着走。
                        setThinkingLevel(level === 'auto' ? null : level)
                        setThinkMenu(false)
                      }}
                    >
                      <span>{THINKING_LABELS[level]}</span>
                      {level === thinking && <Check size={14} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="style-select" ref={styleRef}>
              <button className="style-btn" title="回答风格" onClick={() => setStyleMenu((v) => !v)}>
                <Palette size={15} />
                <span>{styleName}</span>
              </button>
              {styleMenu && (
                <div className="model-menu">
                  {styles.map((s) => (
                    <div
                      key={s.id}
                      className={`model-item ${s.id === styleId ? 'active' : ''}`}
                      onClick={() => {
                        assignStyle(s.id)
                        setStyleMenu(false)
                      }}
                    >
                      <span>{s.name}</span>
                      {s.id === styleId && <Check size={14} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {settings?.memory_enabled !== false && (
              <div className="style-select memory-select" ref={memoryRef}>
                <button
                  className={`style-btn memory-btn${memoryEnabled ? ' on' : ''}`}
                  title={memoryEnabled ? `本次对话带上 ${memoryIds.length} 条记忆，点击关闭` : '本次对话不带记忆，点击开启'}
                  onClick={toggleMemorySwitch}
                >
                  <Bookmark size={15} fill={memoryEnabled ? 'currentColor' : 'none'} />
                  <span>{memoryEnabled ? `记忆 ${memoryCount}` : '记忆'}</span>
                </button>
                <button
                  className="style-btn memory-caret"
                  title="选择要带上的记忆"
                  onClick={openMemoryMenu}
                >
                  <ChevronDown size={13} />
                </button>
                {memoryMenu && (
                  <div className="model-menu memory-menu">
                    {memories.length === 0 ? (
                      <div className="memory-pick-empty">还没有长期记忆，可在设置里添加</div>
                    ) : (
                      memories.map((m) => {
                        const checked = memoryEnabled && memoryIds.includes(m.id)
                        return (
                          <div
                            key={m.id}
                            className={`model-item memory-pick-item ${checked ? 'active' : ''}`}
                            title={m.content}
                            onClick={() => toggleMemoryItem(m.id)}
                          >
                            <span className="memory-pick-text">{m.content}</span>
                            {checked && <Check size={14} />}
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </div>
            )}
            {uploading && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>上传中…</span>}
          </div>

          <div className="composer-right">
            <div className="model-select" ref={menuRef}>
              <button
                className="model-btn"
                title={activeChannelName ? `${activeChannelName} · ${model}` : model}
                onClick={openModelMenu}
              >
                {activeChannelName && <span className="model-btn-channel">{activeChannelName}</span>}
                {model}
                <ChevronDown size={14} />
              </button>
              {modelMenu && (grouped ? (
                <div className="model-menu model-menu-grouped">
                  {chatGroups.map((group) => (
                    <div className="model-group" key={group.id}>
                      <div className="model-group-title">{group.name}</div>
                      {group.models.map((m) => {
                        // 同名模型可能出现在多家渠道下，所以要连渠道一起比。
                        const active = m === model && group.id === chatApiId
                        return (
                          <div
                            key={`${group.id}::${m}`}
                            className={`model-item ${active ? 'active' : ''}`}
                            title={`${group.name} · ${m}`}
                            onClick={() => pickModel(m, group.id)}
                          >
                            <span>{m}</span>
                            {active && <Check size={14} />}
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="model-menu sortable-list" ref={modelSort.containerRef}>
                  {models.map((m, i) => {
                    const sortProps = modelSort.itemProps(i)
                    return (
                      <div
                        key={m}
                        {...sortProps}
                        className={`model-item ${m === model ? 'active' : ''} ${sortProps.className}`}
                        title="拖动可调整顺序"
                        onClick={() => pickModel(m, null)}
                      >
                        <span>{m}</span>
                        {m === model && <Check size={14} />}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>

            {streaming ? (
              <button className="send-btn" title="停止生成" onClick={stopStreaming}>
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button className="send-btn" title="发送" disabled={!canSend} onClick={doSend}>
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-hint">AI 可能会出错，请核查重要信息。Enter 发送 · Shift+Enter 换行</div>
    </div>
  )
}
