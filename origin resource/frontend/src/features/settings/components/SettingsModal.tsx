import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  Activity, AlertTriangle, Brain, CheckCircle2, ChevronDown, Globe, GripVertical, Image,
  LayoutTemplate, ListChecks, Loader2, Maximize2, MessageSquare, Minimize2, Paperclip, Palette,
  Plus, RefreshCw, Server, Trash2, X, XCircle,
} from 'lucide-react'
import { useStore } from '../../../store'
import { testSearchProvider } from '../../../services/api'
import { useUpdateState } from '../../../hooks/useUpdateState'
import { useSortableList } from '../../../hooks/useSortableList'
import type {
  ChatStyle, ImageProvider, PromptTemplate, SearchProvider, SearchTestResult, Settings,
} from '../../../types'
import { DiagnosticsPanel } from '../../diagnostics/components/DiagnosticsPanel'
import { MemoryPanel } from './MemoryPanel'
import { ModelPicker } from './ModelPicker'
import { UpdatePanel } from './UpdatePanel'
import type { ModelSource } from './ModelPicker'

/** 桌面端「多 API」里的一条上游。密钥加密存在主进程，这里只知道有没有。 */
interface DesktopApiEntry {
  id: string
  name: string
  baseUrl: string
  hasKey: boolean
  enabled: boolean
}

interface DesktopBridge {
  getEnhancements: () => Promise<{ apiList?: DesktopApiEntry[] }>
  revealApiKey: (id: string) => Promise<string>
}

const desktopBridge = () =>
  (window as unknown as { chatbotDesktop?: DesktopBridge }).chatbotDesktop

/** 桌面端注入的「多 API」分区只在 Electron 里有意义，浏览器里不显示这一栏。 */
const isDesktop = () => Boolean((window as unknown as { chatbotDesktop?: unknown }).chatbotDesktop)

type SectionKey =
  | 'chat' | 'api' | 'context' | 'search' | 'memory'
  | 'styles' | 'templates' | 'files' | 'images' | 'diagnostics' | 'about'

const SECTIONS: { key: SectionKey; label: string; icon: typeof MessageSquare; desktopOnly?: boolean }[] = [
  { key: 'chat', label: '聊天', icon: MessageSquare },
  { key: 'api', label: '多 API', icon: Server, desktopOnly: true },
  { key: 'context', label: '上下文', icon: Activity },
  { key: 'search', label: '联网搜索', icon: Globe },
  { key: 'memory', label: '长期记忆', icon: Brain },
  { key: 'styles', label: '回答风格', icon: Palette },
  { key: 'templates', label: '提示词模板', icon: LayoutTemplate },
  { key: 'files', label: '附件', icon: Paperclip },
  { key: 'images', label: '图片生成', icon: Image },
  { key: 'diagnostics', label: '诊断', icon: Activity },
  { key: 'about', label: '关于与更新', icon: RefreshCw },
]

/** 设置弹窗使用 draft 暂存编辑，只有点击保存才写入后端。 */
export function SettingsModal() {
  const settingsOpen = useStore((s) => s.settingsOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)

  const [draft, setDraft] = useState<Settings | null>(null)
  const [newModel, setNewModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [section, setSection] = useState<SectionKey>('chat')
  // 正在检测的搜索配置 id，以及每套配置最近一次的检测结果。
  const [testingId, setTestingId] = useState('')
  const [testResults, setTestResults] = useState<Record<string, SearchTestResult>>({})
  // 当前展开的模型选择器。'chat'/'image' 是那两栏，搜索配置用它自己的 id。
  const [pickerFor, setPickerFor] = useState('')
  // 桌面端「多 API」里的上游列表。聊天用的地址和密钥被那一栏接管，
  // 「聊天」栏里的两个输入框是空的（且被隐藏），所以模型清单得问它要。
  const [desktopApis, setDesktopApis] = useState<DesktopApiEntry[]>([])
  // 图片渠道里展开的那几张卡。和桌面端「多 API」一样默认全折叠，
  // 且不做持久化——每次打开设置都从收起状态开始，长列表才看得过来。
  const [openImageIds, setOpenImageIds] = useState<string[]>([])
  // 弹窗尺寸：null 表示用 CSS 里的默认大小。最大化和手动尺寸都不记忆，
  // 每次打开都回到默认，这是用户明确要的。
  const [modalSize, setModalSize] = useState<{ w: number; h: number } | null>(null)
  const [maximized, setMaximized] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  // 「关于与更新」那一栏的红点。面板自己也订阅一份，两处互不影响。
  const { hasUpdate } = useUpdateState()

  useEffect(() => {
    if (settingsOpen && settings) {
      // styles 里的对象也要拷一层，否则编辑风格会直接改到 store 里的数据。
      setDraft({
        ...settings,
        models: [...settings.models],
        styles: settings.styles.map((s) => ({ ...s })),
        prompt_templates: (settings.prompt_templates || []).map((t) => ({ ...t })),
        search_providers: (settings.search_providers || []).map((p) => ({ ...p })),
        image_providers: (settings.image_providers || []).map((p) => ({ ...p })),
      })
    }
  }, [settingsOpen, settings])

  // 每次重新打开都回到第一栏，避免上次停在「诊断」这种角落里。
  useEffect(() => {
    if (settingsOpen) {
      setSection('chat')
      // 模型选择器里的清单是按当时的地址和密钥拉的，重开时一律收起重来。
      setPickerFor('')
      setOpenImageIds([])
      setModalSize(null)
      setMaximized(false)
    }
  }, [settingsOpen])

  // 桌面端的聊天地址与密钥由「多 API」那一栏管理，打开设置时同步一份过来，
  // 「检测可用模型」才知道该问哪个上游。浏览器里没有这个桥，直接跳过。
  useEffect(() => {
    const bridge = desktopBridge()
    if (!settingsOpen || !bridge) return
    let alive = true
    void bridge.getEnhancements()
      .then((data) => { if (alive) setDesktopApis(data?.apiList || []) })
      .catch(() => { if (alive) setDesktopApis([]) })
    return () => { alive = false }
  }, [settingsOpen])

  /**
   * 图片渠道的拖动排序。顺序即故障转移优先级，所以拖动是有实际意义的操作，
   * 不只是排版。把手限定在 `.provider-drag-handle`，否则整张卡都是拖动区，
   * 卡片里的输入框会点不进去。
   *
   * 注意这个 hook 必须写在下面那句提前 return 之前——它不能被条件跳过。
   */
  const imageSort = useSortableList(
    draft?.image_providers?.length ?? 0,
    (from, to) => setDraft((d) => {
      if (!d) return d
      const next = [...(d.image_providers || [])]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return { ...d, image_providers: next }
    }),
    { handleSelector: '.provider-drag-handle' },
  )

  if (!settingsOpen || !draft) return null

  const sections = SECTIONS.filter((item) => !item.desktopOnly || isDesktop())

  const patch = (p: Partial<Settings>) => setDraft((d) => (d ? { ...d, ...p } : d))

  const addModel = () => {
    const name = newModel.trim()
    if (!name || draft.models.includes(name)) return
    patch({ models: [...draft.models, name] })
    setNewModel('')
  }

  /** 从检测出的清单里整体替换模型列表。默认模型不在新列表里时改指第一个。 */
  const applyPickedModels = (models: string[]) => {
    if (!models.length) return
    patch({
      models,
      default_model: models.includes(draft.default_model) ? draft.default_model : models[0],
    })
  }

  /** 展开／收起模型选择器。同一时刻只开一个，免得几份清单同时在拉。 */
  const togglePicker = (key: string) => setPickerFor((cur) => (cur === key ? '' : key))

  /** 把当前填的地址和密钥包成一个上游，给搜索配置、图片这种单来源的地方用。 */
  const singleSource = (id: string, name: string, baseUrl: string, apiKey: string): ModelSource[] =>
    (baseUrl.trim() ? [{ id, name, baseUrl, resolveKey: async () => apiKey }] : [])

  /**
   * 聊天模型能问哪些上游要清单。
   *
   * 桌面端装了「多 API」时，聊天的地址和密钥由那一栏接管（「聊天」栏里的两个
   * 输入框会被隐藏并留空），所以来源取那份列表，密钥点检测时才解密取出；
   * 没装或列表为空时，退回「聊天」栏自己的地址和密钥。
   */
  const chatSources = (): ModelSource[] => {
    const bridge = desktopBridge()
    if (bridge) {
      const usable = desktopApis.filter((api) => api.enabled && api.baseUrl.trim() && api.hasKey)
      if (usable.length) {
        return usable.map((api) => ({
          id: api.id,
          name: api.name,
          baseUrl: api.baseUrl,
          resolveKey: () => bridge.revealApiKey(api.id),
        }))
      }
    }
    return singleSource('legacy', '聊天设置', draft.base_url, draft.api_key)
  }

  const patchStyle = (id: string, p: Partial<ChatStyle>) =>
    patch({ styles: draft.styles.map((s) => (s.id === id ? { ...s, ...p } : s)) })

  const removeStyle = (id: string) => {
    const styles = draft.styles.filter((s) => s.id !== id)
    // 删掉的正好是默认风格时要改指向，否则默认风格会指向一个不存在的 id。
    patch({
      styles,
      default_style_id: draft.default_style_id === id
        ? (styles[0]?.id || 'normal')
        : draft.default_style_id,
    })
  }

  const addStyle = () => {
    // 自定义风格的 id 只要不撞车就行，用时间戳足够。
    const id = `custom-${Date.now().toString(36)}`
    patch({ styles: [...draft.styles, { id, name: '新风格', prompt: '' }] })
  }

  // ---- 联网搜索的多套配置 ----

  const patchProvider = (id: string, p: Partial<SearchProvider>) =>
    patch({
      search_providers: draft.search_providers.map((s) => (s.id === id ? { ...s, ...p } : s)),
    })

  const addProvider = () => {
    const id = `search-${Date.now().toString(36)}`
    patch({
      search_providers: [
        ...draft.search_providers,
        {
          id,
          name: '新搜索配置',
          base_url: '',
          api_key: '',
          model: 'deepseek-v4-flash',
          max_output_tokens: 4000,
        },
      ],
    })
  }

  const removeProvider = (id: string) => {
    // 至少留一套：删空之后这一栏会什么都没有，用户只能重置设置才能恢复。
    if (draft.search_providers.length <= 1) return
    const providers = draft.search_providers.filter((s) => s.id !== id)
    patch({
      search_providers: providers,
      // 删掉的正好是当前使用的那套时要改指向，否则会指向一个不存在的 id。
      search_provider_id:
        draft.search_provider_id === id ? providers[0].id : draft.search_provider_id,
    })
  }

  /** 用草稿里的配置真跑一次检索。不要求先保存，改完就能试。 */
  const runProviderTest = async (provider: SearchProvider) => {
    setTestingId(provider.id)
    try {
      const result = await testSearchProvider(provider)
      setTestResults((prev) => ({ ...prev, [provider.id]: result }))
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [provider.id]: {
          ok: false,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          endpoint: '',
          elapsed_ms: 0,
          sources: [],
          text: '',
          tool_calls: 0,
        },
      }))
    } finally {
      setTestingId('')
    }
  }

  const patchTemplate = (id: string, p: Partial<PromptTemplate>) =>
    patch({ prompt_templates: draft.prompt_templates.map((t) => (t.id === id ? { ...t, ...p } : t)) })

  const removeTemplate = (id: string) =>
    patch({ prompt_templates: draft.prompt_templates.filter((t) => t.id !== id) })

  const addTemplate = () =>
    patch({
      prompt_templates: [
        ...draft.prompt_templates,
        { id: `tpl-${Date.now().toString(36)}`, name: '新模板', content: '' },
      ],
    })

  // ---- 图片生成的多渠道 ----

  const imageProviders = draft.image_providers || []

  const patchImageProvider = (id: string, p: Partial<ImageProvider>) =>
    patch({ image_providers: imageProviders.map((x) => (x.id === id ? { ...x, ...p } : x)) })

  const addImageProvider = () => {
    const id = `img-${Date.now().toString(36)}`
    patch({
      image_providers: [
        ...imageProviders,
        { id, name: '新图片渠道', base_url: '', api_key: '', model: '', enabled: true },
      ],
    })
    // 新加的这张直接展开：刚建出来是空的，折叠着没法填。
    setOpenImageIds((ids) => [...ids, id])
  }

  const removeImageProvider = (id: string) => {
    patch({ image_providers: imageProviders.filter((x) => x.id !== id) })
    setOpenImageIds((ids) => ids.filter((x) => x !== id))
  }

  const toggleImageProvider = (id: string) =>
    setOpenImageIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  // ---- 弹窗尺寸 ----

  /** 从边框拖动改尺寸。dir 里带 e 就改宽、带 s 就改高，右下角两个都改。 */
  const startResize = (dir: 'e' | 's' | 'se') => (event: ReactPointerEvent) => {
    if (event.button !== 0) return
    const node = modalRef.current
    if (!node) return
    event.preventDefault()
    const rect = node.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    // 最大化状态下拖边框视为「退出最大化并从当前尺寸接着调」。
    setMaximized(false)

    const onMove = (e: PointerEvent) => {
      // 弹窗是居中的，鼠标往右拖一格，左边也会往左退一格，
      // 所以宽度要按位移的两倍算，边框才跟得住指针。高度同理。
      const width = dir === 's' ? rect.width : rect.width + (e.clientX - startX) * 2
      const height = dir === 'e' ? rect.height : rect.height + (e.clientY - startY) * 2
      setModalSize({
        w: Math.max(560, Math.min(width, window.innerWidth - 16)),
        h: Math.max(420, Math.min(height, window.innerHeight - 16)),
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      document.body.classList.remove('modal-resizing')
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    document.body.classList.add('modal-resizing')
  }

  const modalStyle = maximized || !modalSize
    ? undefined
    : { width: `${modalSize.w}px`, height: `${modalSize.h}px`, maxWidth: 'none', maxHeight: 'none' }

  const save = async () => {
    setSaving(true)
    try {
      // 确保 default_model 在列表中
      const d = { ...draft }
      if (!d.models.includes(d.default_model) && d.models.length) {
        d.default_model = d.models[0]
      }
      await saveSettings(d)
      setSettingsOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
      <div
        className={`modal modal-settings${maximized ? ' modal-maximized' : ''}`}
        ref={modalRef}
        style={modalStyle}
      >
        <div className="modal-header">
          <h2>设置</h2>
          <div className="modal-header-actions">
            <button
              className="icon-btn"
              title={maximized ? '还原' : '最大化'}
              onClick={() => setMaximized((v) => !v)}
            >
              {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button className="icon-btn" onClick={() => setSettingsOpen(false)}><X size={17} /></button>
          </div>
        </div>

        <div className="settings-split">
          <nav className="settings-nav" aria-label="设置分类">
            {sections.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                className={`settings-nav-item ${section === key ? 'active' : ''}`}
                aria-current={section === key}
                onClick={() => setSection(key)}
              >
                <Icon size={15} />
                <span>{label}</span>
                {key === 'about' && hasUpdate && <span className="nav-dot" aria-label="有新版本" />}
              </button>
            ))}
          </nav>

          {/* 所有分栏都保持挂载、只切换可见性：桌面端注入的 DOM 和面板里的
              草稿状态在来回切栏时不会被丢掉。 */}
          <div className="modal-body settings-body">
            <section className="settings-pane" hidden={section !== 'chat'}>
              <h3 className="settings-section-title">聊天</h3>

              <div className="field field-legacy-api">
                <label>API 地址（Base URL）</label>
                <input
                  value={draft.base_url}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => patch({ base_url: e.target.value })}
                />
              </div>

              <div className="field field-legacy-api">
                <label>API 密钥</label>
                <input
                  type="password"
                  value={draft.api_key}
                  placeholder="sk-…"
                  onChange={(e) => patch({ api_key: e.target.value })}
                />
              </div>

              <div className="field">
                <div className="field-head">
                  <label>模型列表</label>
                  <button
                    className="btn-ghost model-probe-btn"
                    disabled={!chatSources().length}
                    title={
                      chatSources().length
                        ? '读取上游的模型清单，从里面挑'
                        : '先填好 API 地址和密钥（桌面端在「多 API」那一栏）'
                    }
                    onClick={() => togglePicker('chat')}
                  >
                    <ListChecks size={13} /> {pickerFor === 'chat' ? '收起' : '检测可用模型'}
                  </button>
                </div>
                {pickerFor === 'chat' && (
                  <ModelPicker
                    sources={chatSources()}
                    selected={draft.models}
                    multi
                    allowTest
                    onConfirm={applyPickedModels}
                    onClose={() => setPickerFor('')}
                  />
                )}
                <div className="model-list-edit">
                  {draft.models.map((m) => (
                    <div className="model-row" key={m}>
                      <label className="radio">
                        <input
                          type="radio"
                          name="default-model"
                          checked={draft.default_model === m}
                          onChange={() => patch({ default_model: m })}
                        />
                        <span>{m}</span>
                      </label>
                      <button
                        className="icon-btn"
                        disabled={draft.models.length <= 1}
                        onClick={() => patch({ models: draft.models.filter((x) => x !== m) })}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  <div className="model-add">
                    <input
                      value={newModel}
                      placeholder="添加模型名称，如 claude-sonnet-4-5"
                      onChange={(e) => setNewModel(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addModel()}
                    />
                    <button className="btn-ghost" onClick={addModel}><Plus size={14} /> 添加</button>
                  </div>
                </div>
                <div className="hint">选中的单选按钮为默认模型</div>
              </div>

              <div className="field">
                <label>系统提示词（System Prompt）</label>
                <textarea
                  rows={4}
                  value={draft.system_prompt}
                  placeholder="留空则不发送系统提示词"
                  onChange={(e) => patch({ system_prompt: e.target.value })}
                />
              </div>

              <div className="field-row">
                <div className="field">
                  <label>Temperature：{draft.temperature.toFixed(1)}</label>
                  <input
                    type="range" min={0} max={2} step={0.1}
                    value={draft.temperature}
                    onChange={(e) => patch({ temperature: parseFloat(e.target.value) })}
                  />
                </div>
                <div className="field">
                  <label>最大输出 Tokens</label>
                  <input
                    type="number" min={256} max={128000} step={256}
                    value={draft.max_tokens}
                    onChange={(e) => patch({ max_tokens: parseInt(e.target.value) || 8192 })}
                  />
                </div>
              </div>

              <div className="field">
                <label>默认思考档位</label>
                <select
                  value={draft.default_thinking || 'auto'}
                  onChange={(e) => patch({ default_thinking: e.target.value })}
                >
                  <option value="auto">自动（不指定，按上游默认）</option>
                  <option value="minimal">极简</option>
                  <option value="low">简短</option>
                  <option value="medium">中等</option>
                  <option value="high">深入</option>
                </select>
                <span className="hint">
                  发送前可在输入框上临时改档位。并非所有上游模型都支持这个参数，不支持时会被忽略。
                </span>
              </div>

              <div className="field">
                <label>外观主题</label>
                <div className="theme-toggle">
                  <button
                    className={draft.theme === 'light' ? 'active' : ''}
                    onClick={() => patch({ theme: 'light' })}
                  >浅色</button>
                  <button
                    className={draft.theme === 'dark' ? 'active' : ''}
                    onClick={() => patch({ theme: 'dark' })}
                  >深色</button>
                </div>
              </div>
            </section>

            {/* 桌面端把「多 API 与 DeepSeek」注入到这个占位容器里。 */}
            {isDesktop() && (
              <section className="settings-pane" hidden={section !== 'api'}>
                <div className="enh-settings-slot" />
              </section>
            )}
            <section className="settings-pane" hidden={section !== 'context'}>
              <h3 className="settings-section-title">上下文自动压缩</h3>

              <div className="setting-toggle">
                <span>
                  <strong>自动压缩长对话</strong>
                  <small>历史过长时先让模型总结靠前内容，只发送「摘要 + 最近原文」</small>
                </span>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={draft.context_auto_compact}
                    onChange={(e) => patch({ context_auto_compact: e.target.checked })}
                  />
                  <i aria-hidden="true" />
                </label>
              </div>

              <div className="field-row">
                <div className="field">
                  <label>上下文预算（字符）</label>
                  <input
                    type="number" min={4000} max={2000000} step={1000}
                    disabled={!draft.context_auto_compact}
                    value={draft.context_max_chars}
                    onChange={(e) => patch({ context_max_chars: parseInt(e.target.value) || 120000 })}
                  />
                  <div className="hint">约等于可容纳的历史长度，1 个汉字算 1 字符</div>
                </div>
                <div className="field">
                  <label>触发阈值：{draft.context_compact_trigger_percent}%</label>
                  <input
                    type="range" min={10} max={100} step={5}
                    disabled={!draft.context_auto_compact}
                    value={draft.context_compact_trigger_percent}
                    onChange={(e) => patch({ context_compact_trigger_percent: parseInt(e.target.value) || 80 })}
                  />
                  <div className="hint">用量达到预算的这个比例时开始压缩</div>
                </div>
              </div>

              <div className="field">
                <label>保留最近原文（字符）</label>
                <input
                  type="number" min={2000} max={500000} step={1000}
                  disabled={!draft.context_auto_compact}
                  value={draft.context_keep_recent_chars}
                  onChange={(e) => patch({ context_keep_recent_chars: parseInt(e.target.value) || 30000 })}
                />
                <div className="hint">这部分最近对话始终按原文发送，不会被摘要替换</div>
              </div>
            </section>

            <section className="settings-pane" hidden={section !== 'search'}>
              <h3 className="settings-section-title">联网搜索</h3>

              <div className="setting-toggle">
                <span>
                  <strong>允许模型联网搜索</strong>
                  <small>模型判断需要查证时自行发起搜索，结果会附带来源链接</small>
                </span>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={draft.tools_enabled}
                    onChange={(e) => patch({ tools_enabled: e.target.checked })}
                  />
                  <i aria-hidden="true" />
                </label>
              </div>

              <div className="field">
                <label>搜索服务配置</label>
                <div className="style-list-edit">
                  {draft.search_providers.map((p) => {
                    const result = testResults[p.id]
                    const testing = testingId === p.id
                    return (
                      <div className="style-row search-provider" key={p.id}>
                        <div className="style-row-head">
                          <label className="search-provider-pick" title="设为当前使用">
                            <input
                              type="radio"
                              name="search-provider"
                              disabled={!draft.tools_enabled}
                              checked={draft.search_provider_id === p.id}
                              onChange={() => patch({ search_provider_id: p.id })}
                            />
                          </label>
                          <input
                            className="style-name"
                            value={p.name}
                            placeholder="配置名称，例如 某某中转站"
                            disabled={!draft.tools_enabled}
                            onChange={(e) => patchProvider(p.id, { name: e.target.value })}
                          />
                          <button
                            className="btn-ghost search-test-btn"
                            disabled={!draft.tools_enabled || testing || !p.api_key.trim()}
                            title={p.api_key.trim() ? '真跑一次检索，验证能不能联网' : '先填 API 密钥'}
                            onClick={() => runProviderTest(p)}
                          >
                            {testing ? <Loader2 size={13} className="spin" /> : <Globe size={13} />}
                            {testing ? '检测中…' : '检测'}
                          </button>
                          <button
                            className="icon-btn"
                            title={draft.search_providers.length <= 1 ? '至少保留一套配置' : '删除这套配置'}
                            disabled={draft.search_providers.length <= 1}
                            onClick={() => removeProvider(p.id)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>

                        <div className="field-row">
                          <div className="field">
                            <label>API 地址（Base URL）</label>
                            <input
                              value={p.base_url}
                              placeholder="https://api.deepseek.com"
                              disabled={!draft.tools_enabled}
                              onChange={(e) => patchProvider(p.id, { base_url: e.target.value })}
                            />
                          </div>
                          <div className="field">
                            <label>API 密钥</label>
                            <input
                              type="password"
                              value={p.api_key}
                              placeholder="sk-…"
                              disabled={!draft.tools_enabled}
                              onChange={(e) => patchProvider(p.id, { api_key: e.target.value })}
                            />
                          </div>
                        </div>

                        <div className="field-row">
                          <div className="field">
                            <div className="field-head">
                              <label>搜索模型</label>
                              <button
                                className="btn-ghost model-probe-btn"
                                disabled={
                                  !draft.tools_enabled || !p.base_url.trim() || !p.api_key.trim()
                                }
                                title={p.api_key.trim() ? '读取这个上游的模型清单' : '先填地址和密钥'}
                                onClick={() => togglePicker(p.id)}
                              >
                                <ListChecks size={13} /> {pickerFor === p.id ? '收起' : '检测'}
                              </button>
                            </div>
                            <input
                              value={p.model}
                              placeholder="deepseek-v4-flash"
                              disabled={!draft.tools_enabled}
                              onChange={(e) => patchProvider(p.id, { model: e.target.value })}
                            />
                          </div>
                          <div className="field">
                            <label>单次搜索输出上限（Tokens）</label>
                            <input
                              type="number" min={1000} max={32000} step={500}
                              value={p.max_output_tokens}
                              disabled={!draft.tools_enabled}
                              onChange={(e) => patchProvider(p.id, {
                                max_output_tokens: parseInt(e.target.value) || 4000,
                              })}
                            />
                          </div>
                        </div>

                        {pickerFor === p.id && (
                          <ModelPicker
                            sources={singleSource(p.id, p.name, p.base_url, p.api_key)}
                            selected={[p.model]}
                            onConfirm={(models) => patchProvider(p.id, { model: models[0] })}
                            onClose={() => setPickerFor('')}
                          />
                        )}

                        {result && (
                          <div className={`search-test-result ${result.status}`}>
                            <div className="search-test-head">
                              {result.status === 'ok' && <CheckCircle2 size={14} />}
                              {result.status === 'no_sources' && <AlertTriangle size={14} />}
                              {result.status === 'error' && <XCircle size={14} />}
                              <span>{result.message}</span>
                              {result.elapsed_ms > 0 && (
                                <em>{(result.elapsed_ms / 1000).toFixed(1)}s</em>
                              )}
                            </div>
                            {result.endpoint && (
                              <div className="search-test-line">实际接口：{result.endpoint}</div>
                            )}
                            {result.sources.length > 0 && (
                              <div className="search-test-line">
                                命中来源：{result.sources.slice(0, 6).map((s) => s.host || s.url).join('、')}
                                {result.sources.length > 6 ? ` 等 ${result.sources.length} 个` : ''}
                              </div>
                            )}
                            {result.text && (
                              <div className="search-test-line search-test-text">{result.text}</div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  <button className="btn-ghost" disabled={!draft.tools_enabled} onClick={addProvider}>
                    <Plus size={14} /> 添加搜索配置
                  </button>
                </div>
                <div className="hint">
                  搜索走独立上游，与聊天接口无关，只有选中（左侧圆点）的那一套会被使用，
                  失败时不会自动切到别的配置。目前只有 DeepSeek 的 Responses 接口内置搜索，
                  中转站需要它自己也支持转发这个接口。地址带不带 /v1 都行，后端会自动试。
                </div>
              </div>
              <div className="hint">
                一次联网问答的输入量约为普通对话的十几倍，按量计费时请留意消耗；
                「检测」按钮同样会真实发起一次检索。
              </div>
            </section>
            <section className="settings-pane" hidden={section !== 'memory'}>
              <h3 className="settings-section-title">长期记忆</h3>

              <div className="setting-toggle">
                <span>
                  <strong>启用长期记忆</strong>
                  <small>把记住的信息拼进系统提示词，所有新对话都会带上</small>
                </span>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={draft.memory_enabled}
                    onChange={(e) => patch({ memory_enabled: e.target.checked })}
                  />
                  <i aria-hidden="true" />
                </label>
              </div>

              <div className="setting-toggle">
                <span>
                  <strong>允许模型主动记录</strong>
                  <small>对话中说「记住…」时由模型自行写入，关掉后只能在下面手工维护</small>
                </span>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    disabled={!draft.memory_enabled}
                    checked={draft.memory_auto_capture}
                    onChange={(e) => patch({ memory_auto_capture: e.target.checked })}
                  />
                  <i aria-hidden="true" />
                </label>
              </div>

              <div className="field-row">
                <div className="field">
                  <label>最多保留条数</label>
                  <input
                    type="number" min={1} max={500} step={1}
                    disabled={!draft.memory_enabled}
                    value={draft.memory_max_items}
                    onChange={(e) => patch({ memory_max_items: parseInt(e.target.value) || 50 })}
                  />
                  <div className="hint">超出后淘汰最旧的记忆</div>
                </div>
                <div className="field">
                  <label>记忆块字符上限</label>
                  <input
                    type="number" min={200} max={50000} step={200}
                    disabled={!draft.memory_enabled}
                    value={draft.memory_max_chars}
                    onChange={(e) => patch({ memory_max_chars: parseInt(e.target.value) || 4000 })}
                  />
                  <div className="hint">记忆每轮都要重发，调大会持续摊在每次请求上</div>
                </div>
              </div>

              <MemoryPanel enabled={draft.memory_enabled} />
            </section>

            <section className="settings-pane" hidden={section !== 'styles'}>
              <h3 className="settings-section-title">回答风格</h3>

              <div className="field">
                <label>默认风格</label>
                <select
                  value={draft.default_style_id}
                  onChange={(e) => patch({ default_style_id: e.target.value })}
                >
                  {draft.styles.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <div className="hint">新对话默认使用这个风格，单个对话可在输入框左下角单独切换</div>
              </div>

              <div className="field">
                <label>风格指令</label>
                <div className="style-list-edit">
                  {draft.styles.map((s) => (
                    <div className="style-row" key={s.id}>
                      <div className="style-row-head">
                        <input
                          className="style-name"
                          value={s.name}
                          placeholder="风格名称"
                          onChange={(e) => patchStyle(s.id, { name: e.target.value })}
                        />
                        {s.builtin ? (
                          <span className="style-tag">内置</span>
                        ) : (
                          <button
                            className="icon-btn"
                            title="删除风格"
                            onClick={() => removeStyle(s.id)}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                      <textarea
                        rows={2}
                        value={s.prompt}
                        placeholder={s.id === 'normal' ? '默认风格通常留空' : '这个风格追加的系统指令'}
                        onChange={(e) => patchStyle(s.id, { prompt: e.target.value })}
                      />
                    </div>
                  ))}
                  <button className="btn-ghost" onClick={addStyle}><Plus size={14} /> 添加风格</button>
                </div>
                <div className="hint">内置风格可以改措辞但不能删除</div>
              </div>
            </section>

            <section className="settings-pane" hidden={section !== 'templates'}>
              <h3 className="settings-section-title">提示词模板</h3>

              <div className="field">
                <div className="style-list-edit">
                  {draft.prompt_templates.map((t) => (
                    <div className="style-row" key={t.id}>
                      <div className="style-row-head">
                        <input
                          className="style-name"
                          value={t.name}
                          placeholder="模板名称"
                          onChange={(e) => patchTemplate(t.id, { name: e.target.value })}
                        />
                        <button className="icon-btn" title="删除模板" onClick={() => removeTemplate(t.id)}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <textarea
                        rows={3}
                        value={t.content}
                        placeholder="模板正文，用 {{input}} 表示输入框里已有的文字"
                        onChange={(e) => patchTemplate(t.id, { content: e.target.value })}
                      />
                    </div>
                  ))}
                  <button className="btn-ghost" onClick={addTemplate}><Plus size={14} /> 添加模板</button>
                </div>
                <div className="hint">
                  模板从输入框左下角选用，只把正文填进输入框，改不改、发不发都由你决定。
                  正文里的 {'{{input}}'} 会替换成输入框里已经打好的字，没有这个占位符时模板会放在原文前面。
                </div>
              </div>
            </section>
            <section className="settings-pane" hidden={section !== 'files'}>
              <h3 className="settings-section-title">附件大小限制</h3>

              <div className="field-row">
                <div className="field">
                  <label>单个文件上限（MB）</label>
                  <input
                    type="number" min={1} max={100} step={1}
                    value={draft.single_file_max_mb}
                    onChange={(e) => patch({ single_file_max_mb: parseInt(e.target.value) || 20 })}
                  />
                </div>
                <div className="field">
                  <label>单个文件正文上限（字符）</label>
                  <input
                    type="number" min={1000} max={1000000} step={1000}
                    value={draft.single_file_max_chars}
                    onChange={(e) => patch({ single_file_max_chars: parseInt(e.target.value) || 60000 })}
                  />
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label>单条消息附件合计上限（MB）</label>
                  <input
                    type="number" min={1} max={200} step={1}
                    value={draft.message_files_max_mb}
                    onChange={(e) => patch({ message_files_max_mb: parseInt(e.target.value) || 30 })}
                  />
                </div>
                <div className="field">
                  <label>单条消息正文合计上限（字符）</label>
                  <input
                    type="number" min={1000} max={2000000} step={1000}
                    value={draft.message_files_max_chars}
                    onChange={(e) => patch({ message_files_max_chars: parseInt(e.target.value) || 150000 })}
                  />
                </div>
              </div>
              <div className="hint">
                MB 限制在上传时生效；字符限制在发送给模型时生效，超出部分会被截断并标注。
              </div>
            </section>

            <section className="settings-pane" hidden={section !== 'images'}>
              <h3 className="settings-section-title">图片生成</h3>

              <div className="field">
                <label>图片渠道</label>
                <div className="provider-list" ref={imageSort.containerRef}>
                  {imageProviders.map((p, i) => {
                    const sortProps = imageSort.itemProps(i)
                    const open = openImageIds.includes(p.id)
                    return (
                      <div
                        key={p.id}
                        {...sortProps}
                        className={`provider-card ${sortProps.className}${open ? ' open' : ''}`}
                      >
                        <div className="provider-head">
                          <span className="provider-drag-handle" title="拖动调整顺序">
                            <GripVertical size={14} />
                          </span>
                          <input
                            className="style-name"
                            value={p.name}
                            placeholder="渠道名称，例如 某某中转站"
                            onChange={(e) => patchImageProvider(p.id, { name: e.target.value })}
                          />
                          <label className="provider-enabled" title="停用后跳过这个渠道">
                            <input
                              type="checkbox"
                              checked={p.enabled !== false}
                              onChange={(e) => patchImageProvider(p.id, { enabled: e.target.checked })}
                            />
                            <span>启用</span>
                          </label>
                          <button
                            className="icon-btn"
                            title="删除这个渠道"
                            onClick={() => removeImageProvider(p.id)}
                          >
                            <Trash2 size={13} />
                          </button>
                          <button
                            className={`icon-btn provider-toggle${open ? ' open' : ''}`}
                            title={open ? '收起' : '展开'}
                            onClick={() => toggleImageProvider(p.id)}
                          >
                            <ChevronDown size={15} />
                          </button>
                        </div>

                        {open && (
                          <div className="provider-body">
                            <div className="field-row">
                              <div className="field">
                                <label>API 地址（Base URL）</label>
                                <input
                                  value={p.base_url}
                                  placeholder="https://api.example.com/v1"
                                  onChange={(e) => patchImageProvider(p.id, { base_url: e.target.value })}
                                />
                              </div>
                              <div className="field">
                                <label>API 密钥</label>
                                <input
                                  type="password"
                                  value={p.api_key}
                                  placeholder="sk-…"
                                  onChange={(e) => patchImageProvider(p.id, { api_key: e.target.value })}
                                />
                              </div>
                            </div>

                            <div className="field">
                              <div className="field-head">
                                <label>图片模型</label>
                                <button
                                  className="btn-ghost model-probe-btn"
                                  disabled={!p.base_url.trim() || !p.api_key.trim()}
                                  title={p.api_key.trim() ? '读取这个上游的模型清单' : '先填地址和密钥'}
                                  onClick={() => togglePicker(p.id)}
                                >
                                  <ListChecks size={13} /> {pickerFor === p.id ? '收起' : '检测可用模型'}
                                </button>
                              </div>
                              <input
                                value={p.model}
                                placeholder="gpt-image-2"
                                onChange={(e) => patchImageProvider(p.id, { model: e.target.value })}
                              />
                              {pickerFor === p.id && (
                                <ModelPicker
                                  sources={singleSource(p.id, p.name, p.base_url, p.api_key)}
                                  selected={[p.model]}
                                  onConfirm={(models) => patchImageProvider(p.id, { model: models[0] })}
                                  onClose={() => setPickerFor('')}
                                />
                              )}
                              <div className="hint">
                                清单是上游的完整模型列表，画图模型通常带 image / dall / flux / seedream 等字样。
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {imageProviders.length === 0 && (
                    <div className="provider-empty">还没有图片渠道，添加一个才能生成图片</div>
                  )}
                  <button className="btn-ghost" onClick={addImageProvider}>
                    <Plus size={14} /> 添加图片渠道
                  </button>
                </div>
                <div className="hint">
                  和「多 API」一样按从上到下的顺序使用：排在前面的渠道失败了才换下一个，
                  拖动六个小点可以调整优先级。渠道里的模型留空时，沿用第一个可用渠道的模型名。
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label>图片尺寸</label>
                  <input
                    value={draft.image_size}
                    placeholder="1920x1080"
                    onChange={(e) => patch({ image_size: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>图片质量</label>
                  <select
                    value={draft.image_quality}
                    onChange={(e) => patch({ image_quality: e.target.value })}
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="auto">auto</option>
                  </select>
                </div>
              </div>
              <div className="hint">尺寸和质量是所有渠道共用的，不随渠道切换。</div>
            </section>

            <section className="settings-pane" hidden={section !== 'diagnostics'}>
              <h3 className="settings-section-title">诊断</h3>
              <DiagnosticsPanel />
            </section>

            <section className="settings-pane" hidden={section !== 'about'}>
              <h3 className="settings-section-title">关于与更新</h3>
              <UpdatePanel />
            </section>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-ghost" onClick={() => setSettingsOpen(false)}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>

        {/* 三个拖动条挂在最外层，最大化时由 CSS 隐藏。 */}
        {!maximized && (
          <>
            <div className="modal-resize modal-resize-e" onPointerDown={startResize('e')} />
            <div className="modal-resize modal-resize-s" onPointerDown={startResize('s')} />
            <div className="modal-resize modal-resize-se" onPointerDown={startResize('se')} />
          </>
        )}
      </div>
    </div>
  )
}
