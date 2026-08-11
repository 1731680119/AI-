import { create } from 'zustand'
import type { ConversationMeta, ConversationTree, Message, Settings, Attachment, AppMode, ImageRecord, CodeExecRequest, ContextCompactInfo, ToolCall, ToolProgress, Project } from '../types'
import * as api from '../services/api'
import { logAction, logError, logWarn } from '../services/diagnostics'

export interface Artifact {
  id: string
  title: string
  language: string
  code: string
  /** 「消息 id#同语言块序号」。版本历史靠它在消息树里定位当前显示的是哪一版。 */
  versionId?: string
}

/** 按 call_id 定位并更新某一次工具调用；并行调用时会有多条同时在跑。 */
function patchCall(
  calls: ToolCall[] | undefined,
  callId: string,
  fn: (call: ToolCall) => Partial<ToolCall>,
): ToolCall[] {
  return (calls || []).map((c) => (c.call_id === callId ? { ...c, ...fn(c) } : c))
}

export interface SendMessageOptions {
  /** 编辑旧问题时，新问题应连接到哪个父消息。 */
  parentId?: string | null
  /** 重新生成回答时，被替换的旧回答 ID。 */
  regenerateFrom?: string
  /** 继续生成时，要续写的那条回答 ID；新内容追加进这条消息。 */
  continueFrom?: string
}

/** 新会话尚未落库，项目和风格先记在这里，创建时一并提交。 */
export interface PendingConversationMeta {
  projectId: string | null
  styleId: string | null
}

/** 全站共享状态和可执行操作的完整类型。 */
export interface Store {
  // 聊天、设置和通用界面状态
  settings: Settings | null
  conversations: ConversationMeta[]
  currentId: string | null
  tree: ConversationTree | null
  streaming: boolean
  abortCtrl: AbortController | null
  sidebarOpen: boolean
  settingsOpen: boolean
  artifact: Artifact | null
  error: string | null
  /** 最近一次上下文自动压缩的结果，用于在聊天区给出提示。 */
  contextNotice: ContextCompactInfo | null
  /** 正在等用户确认的代码执行。非空时弹确认框，后端此刻停在等待上。 */
  codeExecRequest: CodeExecRequest | null
  /** 答复确认框。approved 为假即拒绝；code 非空表示用户改过代码。 */
  answerCodeExec: (approved: boolean, code?: string, trust?: boolean) => Promise<void>

  // 项目状态
  projects: Project[]
  /** 侧边栏里正在筛选的项目；null 表示显示全部会话。 */
  projectFilter: string | null
  /** 正在编辑的项目：'new' 表示新建，字符串 id 表示改已有项目。 */
  projectEditing: string | null
  /** 新会话在落库前选定的项目和风格。 */
  pending: PendingConversationMeta
  /** 本次运行选定的思考档位；null 表示跟随设置里的默认档位。 */
  thinkingLevel: string | null
  setThinkingLevel: (level: string | null) => void

  // 图片功能状态
  mode: AppMode
  images: ImageRecord[]
  imageBusy: boolean
  selectedImageId: string | null

  init: () => Promise<void>
  loadConversations: () => Promise<void>
  selectConversation: (id: string | null) => Promise<void>
  newConversation: () => Promise<void>
  removeConversation: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  refreshTree: () => Promise<void>
  sendMessage: (content: string, attachments: Attachment[], opts?: SendMessageOptions) => Promise<void>
  stopStreaming: () => void
  switchBranch: (nodeId: string) => Promise<void>
  setSidebarOpen: (v: boolean) => void
  setSettingsOpen: (v: boolean) => void
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  setArtifact: (a: Artifact | null) => void
  setError: (e: string | null) => void
  setContextNotice: (info: ContextCompactInfo | null) => void

  loadProjects: () => Promise<void>
  saveProject: (
    id: string | null,
    body: { name: string; description: string; instructions: string },
  ) => Promise<void>
  removeProject: (id: string, deleteConversations?: boolean) => Promise<void>
  setProjectFilter: (id: string | null) => void
  setProjectEditing: (id: string | null) => void
  /** 设置当前会话的项目；无当前会话时记入 pending。 */
  assignProject: (projectId: string | null) => Promise<void>
  /** 设置当前会话的回答风格；无当前会话时记入 pending。 */
  assignStyle: (styleId: string | null) => Promise<void>

  setMode: (m: AppMode) => void
  loadImages: () => Promise<void>
  selectImage: (id: string | null) => void
  generateImages: (req: api.GenerateImageRequest) => Promise<void>
  editImage: (
    file: File,
    req: Omit<api.GenerateImageRequest, 'n'>,
    references?: api.ReferenceImageInput[],
  ) => Promise<void>
  removeImage: (id: string) => Promise<void>
}

export const useStore = create<Store>((set, get) => ({
  // 初始值只描述“页面刚打开、尚未读取后端”时的状态。
  settings: null,
  conversations: [],
  currentId: null,
  tree: null,
  streaming: false,
  abortCtrl: null,
  sidebarOpen: true,
  settingsOpen: false,
  artifact: null,
  error: null,
  contextNotice: null,
  codeExecRequest: null,

  answerCodeExec: async (approved, code, trust) => {
    const req = get().codeExecRequest
    if (!req) return
    // 先关框：后端已经收到答复，重复提交只会拿到 404。
    set({ codeExecRequest: null })
    try {
      await api.submitCodeExecDecision({
        request_id: req.request_id,
        approved,
        code,
        trust_conversation: !!trust,
        conversation_id: req.conversation_id,
      })
    } catch (e) {
      // 等待超时后请求已不存在，此时那一轮已按拒绝处理，不需要再打扰用户。
      logError('store', `代码执行确认提交失败：${(e as Error).message}`, {
        request_id: req.request_id,
      })
    }
  },


  projects: [],
  projectFilter: null,
  projectEditing: null,
  pending: { projectId: null, styleId: null },
  thinkingLevel: null,
  setThinkingLevel: (level) => set({ thinkingLevel: level }),

  mode: 'chat',
  images: [],
  imageBusy: false,
  selectedImageId: null,

  init: async () => {
    // 设置和会话互不依赖，并行读取可以缩短首屏等待时间。
    const [settings, conversations, projects] = await Promise.all([
      api.fetchSettings(),
      api.listConversations(),
      api.listProjects(),
    ])
    document.documentElement.dataset.theme = settings.theme
    set({ settings, conversations, projects })
  },

  loadConversations: async () => {
    set({ conversations: await api.listConversations() })
  },

  selectConversation: async (id) => {
    set({ currentId: id, artifact: null, error: null })
    if (id) {
      logAction('打开会话', { conversation_id: id })
      try {
        set({ tree: await api.getConversation(id) })
      } catch (error) {
        // 会话打不开时界面只是回到空白，不记一条的话这个失败就彻底看不见了。
        logWarn('store', `打开会话失败：${(error as Error).message}`, { conversation_id: id })
        set({ tree: null, currentId: null })
      }
    } else {
      set({ tree: null })
    }
  },

  newConversation: async () => {
    // 在某个项目下点「新对话」时，默认继续留在这个项目里。
    const { projectFilter } = get()
    set({
      currentId: null, tree: null, artifact: null, error: null,
      pending: { projectId: projectFilter, styleId: null },
    })
  },

  removeConversation: async (id) => {
    logAction('删除会话', { conversation_id: id })
    await api.deleteConversation(id)
    const { currentId } = get()
    await get().loadConversations()
    if (currentId === id) {
      set({ currentId: null, tree: null })
    }
  },

  rename: async (id, title) => {
    await api.renameConversation(id, title)
    await get().loadConversations()
  },

  refreshTree: async () => {
    const { currentId } = get()
    if (currentId) set({ tree: await api.getConversation(currentId) })
  },

  sendMessage: async (content, attachments, opts = {}) => {
    let { currentId } = get()
    const { settings } = get()
    set({ error: null })

    // 若无当前会话，先创建
    if (!currentId) {
      const { pending } = get()
      const conv = await api.createConversation({
        projectId: pending.projectId,
        styleId: pending.styleId,
      })
      currentId = conv.id
      set({ currentId })
      await get().loadConversations()
      set({ tree: await api.getConversation(currentId) })
    }

    // 只记元数据，不记正文：正文属于对话内容，默认不进日志。
    const label = opts.continueFrom ? '继续生成'
      : opts.regenerateFrom ? '重新生成回答'
      : '发送消息'
    logAction(label, {
      conversation_id: currentId,
      chars: content.length,
      attachments: attachments.length,
      model: settings?.default_model,
    })

    const ctrl = new AbortController()
    set({
      streaming: true,
      abortCtrl: ctrl,
    })

    // 乐观更新：先插入临时消息，让用户按下发送后立刻看到内容。
    // 请求结束后会从服务器重新读取消息树，临时 ID 不会写入数据库。
    const tempUserId = 'temp-user'
    const tempAsstId = 'temp-asst'
    const isRegen = !!opts.regenerateFrom
    // 继续生成续写的是已存在的那条回答，所以流式片段直接打到它的真实 ID 上。
    const streamTargetId = opts.continueFrom || tempAsstId
    if (opts.continueFrom) {
      set((s) => s.tree ? {
        tree: {
          ...s.tree,
          messages: s.tree.messages.map((m) =>
            m.id === opts.continueFrom ? { ...m, streaming: true } : m,
          ),
        },
      } : {})
    } else set((s) => {
      if (!s.tree) return {}
      const msgs = [...s.tree.messages]
      if (!isRegen) {
        msgs.push({
          id: tempUserId,
          parent_id: opts.parentId !== undefined ? opts.parentId : s.tree.active_leaf_id,
          role: 'user', content, attachments, created_at: '', thinking: null,
        })
      }
      msgs.push({
        id: tempAsstId,
        parent_id: tempUserId,
        role: 'assistant', content: '', attachments: [], created_at: '',
        thinking: null, streaming: true, thinkingOpen: true,
      })
      return { tree: { ...s.tree, messages: msgs, active_leaf_id: tempAsstId } }
    })

    const patchAsst = (fn: (m: Message) => Partial<Message>) => {
      // 每收到一个 SSE 小片段，只更新临时回答，避免重建其他历史消息。
      set((s) => {
        if (!s.tree) return {}
        const msgs = s.tree.messages.map((m) =>
          m.id === streamTargetId ? { ...m, ...fn(m) } : m,
        )
        return { tree: { ...s.tree, messages: msgs } }
      })
    }

    try {
      await api.streamChat(
        {
          conversation_id: currentId!,
          content,
          attachments,
          model: settings?.default_model,
          parent_id: opts.parentId,
          regenerate_from: opts.regenerateFrom,
          continue_from: opts.continueFrom,
          thinking: get().thinkingLevel || undefined,
        },
        (ev) => {
          if (ev.type === 'thinking') {
            patchAsst((m) => ({ thinking: (m.thinking || '') + (ev.text as string) }))
          } else if (ev.type === 'content') {
            patchAsst((m) => ({
              content: m.content + (ev.text as string),
              thinkingOpen: false,
            }))
          } else if (ev.type === 'tool_start') {
            patchAsst((m) => ({
              tool_calls: [...(m.tool_calls || []), {
                call_id: ev.call_id as string,
                tool: ev.tool as string,
                arguments: (ev.arguments as Record<string, unknown>) || {},
                running: true,
                progress: [],
              }],
            }))
          } else if (ev.type === 'tool_progress' && ev.action === 'code_exec_confirm') {
            // 后端此刻停在等待上，所以这里只弹框，不改流的状态。
            set({
              codeExecRequest: {
                request_id: ev.request_id as string,
                code: (ev.code as string) || '',
                purpose: (ev.purpose as string) || '',
                modules: (ev.modules as string[]) || [],
                conversation_id: (ev.conversation_id as string) || '',
                timeout_seconds: (ev.timeout_seconds as number) || 120,
              },
            })
            patchAsst((m) => ({
              tool_calls: patchCall(m.tool_calls, ev.call_id as string, () => ({
                awaitingConfirm: true,
              })),
            }))
          } else if (
            ev.type === 'tool_progress'
            && (ev.action === 'code_exec_running' || ev.action === 'code_exec_auto')
          ) {
            // 确认已经过了（或免询问直接放行），卡片从「等待确认」转为「正在运行」。
            patchAsst((m) => ({
              tool_calls: patchCall(m.tool_calls, ev.call_id as string, () => ({
                awaitingConfirm: false,
                arguments: { code: (ev.code as string) || '' },
              })),
            }))
          } else if (ev.type === 'tool_progress') {
            patchAsst((m) => ({
              tool_calls: patchCall(m.tool_calls, ev.call_id as string, (call) => ({
                progress: [...(call.progress || []), {
                  action: (ev.action as ToolProgress['action']) || 'search',
                  url: (ev.url as string) || '',
                  queries: (ev.queries as string[]) || [],
                }],
              })),
            }))
          } else if (ev.type === 'tool_end') {
            patchAsst((m) => ({
              tool_calls: patchCall(m.tool_calls, ev.call_id as string, () => ({
                running: false,
                display: ev.display as ToolCall['display'],
              })),
            }))
          } else if (ev.type === 'tool_error') {
            patchAsst((m) => ({
              tool_calls: patchCall(m.tool_calls, ev.call_id as string, () => ({
                running: false,
                awaitingConfirm: false,
                error: ev.message as string,
              })),
            }))
          } else if (ev.type === 'context_compacted') {
            set({ contextNotice: ev.context as ContextCompactInfo })
          } else if (ev.type === 'error') {
            logError('store', `模型返回错误：${ev.message as string}`, {
              conversation_id: currentId,
              model: settings?.default_model,
            })
            set({ error: ev.message as string })
          } else if (ev.type === 'title') {
            get().loadConversations()
          }
        },
        ctrl.signal,
      )
    } catch (e) {
      const failure = e as Error
      if (failure.name !== 'AbortError') {
        logError('store', `对话请求失败：${failure.message}`, {
          conversation_id: currentId,
          model: settings?.default_model,
        }, failure.stack)
        set({ error: failure.message })
      } else {
        logAction('用户中止生成', { conversation_id: currentId })
      }
    }

    set({ streaming: false, abortCtrl: null })
    // 用服务器保存后的真实 ID、时间和完整内容替换临时消息。
    await get().refreshTree()
    await get().loadConversations()
  },

  stopStreaming: () => {
    get().abortCtrl?.abort()
    set({ streaming: false, abortCtrl: null })
  },

  switchBranch: async (nodeId) => {
    const { currentId } = get()
    if (!currentId) return
    await api.setActiveLeaf(currentId, nodeId)
    await get().refreshTree()
  },

  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),

  saveSettings: async (patch) => {
    // 只记改了哪些项，不记值本身：里面可能有 API Key。
    logAction('保存设置', { keys: Object.keys(patch) })
    const settings = await api.saveSettings(patch)
    document.documentElement.dataset.theme = settings.theme
    set({ settings })
  },

  setArtifact: (a) => set({ artifact: a }),
  setError: (e) => set({ error: e }),
  setContextNotice: (info) => set({ contextNotice: info }),

  loadProjects: async () => {
    set({ projects: await api.listProjects() })
  },

  saveProject: async (id, body) => {
    logAction(id ? '修改项目' : '新建项目', { instructions_chars: body.instructions.length })
    if (id) await api.updateProject(id, body)
    else await api.createProject(body)
    await get().loadProjects()
    set({ projectEditing: null })
  },

  removeProject: async (id, deleteConversations = false) => {
    logAction('删除项目', { project_id: id, delete_conversations: deleteConversations })
    await api.deleteProject(id, deleteConversations)
    const { projectFilter } = get()
    await Promise.all([get().loadProjects(), get().loadConversations()])
    if (projectFilter === id) set({ projectFilter: null })
    // 归属被解除或会话被删，当前打开的会话得重新读一次。
    if (get().currentId) await get().refreshTree()
  },

  setProjectFilter: (id) => set({ projectFilter: id }),
  setProjectEditing: (id) => set({ projectEditing: id }),

  assignProject: async (projectId) => {
    const { currentId } = get()
    if (!currentId) {
      set((s) => ({ pending: { ...s.pending, projectId } }))
      return
    }
    await api.setConversationProject(currentId, projectId)
    await Promise.all([get().refreshTree(), get().loadProjects(), get().loadConversations()])
  },

  assignStyle: async (styleId) => {
    const { currentId } = get()
    if (!currentId) {
      set((s) => ({ pending: { ...s.pending, styleId } }))
      return
    }
    await api.setConversationStyle(currentId, styleId)
    await get().refreshTree()
  },

  setMode: (m) => {
    set({ mode: m, error: null })
    if (m === 'image') get().loadImages()
  },

  loadImages: async () => {
    try {
      set({ images: await api.listImages() })
    } catch {
      /* 后端未就绪时静默 */
    }
  },

  selectImage: (id) => set({ selectedImageId: id }),

  generateImages: async (req) => {
    set({ imageBusy: true, error: null })
    logAction('生成图片', { model: req.model, size: req.size, quality: req.quality })
    try {
      const rec = await api.generateImages(req)
      set((s) => ({ images: [rec, ...s.images], selectedImageId: rec.id }))
    } catch (e) {
      const failure = e as Error
      logError('store', `图片生成失败：${failure.message}`, { model: req.model }, failure.stack)
      set({ error: failure.message })
    } finally {
      set({ imageBusy: false })
    }
  },

  editImage: async (file, req, references = []) => {
    set({ imageBusy: true, error: null })
    logAction('编辑图片', { model: req.model, references: references.length })
    try {
      const rec = await api.editImage(file, req, references)
      set((s) => ({ images: [rec, ...s.images], selectedImageId: rec.id }))
    } catch (e) {
      const failure = e as Error
      logError('store', `图片编辑失败：${failure.message}`, { model: req.model }, failure.stack)
      set({ error: failure.message })
    } finally {
      set({ imageBusy: false })
    }
  },

  removeImage: async (id) => {
    await api.deleteImageRecord(id)
    set((s) => ({
      images: s.images.filter((r) => r.id !== id),
      selectedImageId: s.selectedImageId === id ? null : s.selectedImageId,
    }))
  },
}))
