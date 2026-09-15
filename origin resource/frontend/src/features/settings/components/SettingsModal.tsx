import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  Activity, AlertTriangle, Brain, CheckCircle2, Globe, Image,
  LayoutTemplate, ListChecks, Loader2, Maximize2, MessageSquare, Minimize2, Paperclip, Palette,
  Plus, RefreshCw, Server, Trash2, X, XCircle,
} from 'lucide-react'
import { useStore } from '../../../store'
import { testSearchProvider } from '../../../services/api'
import { useUpdateState } from '../../../hooks/useUpdateState'
import type {
  ChatStyle, PromptTemplate, SearchProvider, SearchTestResult, Settings,
} from '../../../types'
import { DiagnosticsPanel } from '../../diagnostics/components/DiagnosticsPanel'
import { MemoryPanel } from './MemoryPanel'
import { ModelPicker } from './ModelPicker'
import { UpdatePanel } from './UpdatePanel'
import type { ModelSource } from './ModelPicker'

/** 桌面端注入的「多 API」分区只在 Electron 里有意义，浏览器里不显示这一栏。 */
const isDesktop = () => Boolean((window as unknown as { chatbotDesktop?: unknown }).chatbotDesktop)

/** 关窗询问要用到的两个桥接方法。浏览器里没有 chatbotDesktop，取到的就是 undefined。 */
interface CloseBridge {
  setSettingsDirty?: (dirty: boolean) => void
  onCloseRequested?: (cb: () => void) => () => void
  resolveClose?: (action: 'proceed' | 'cancel') => void
}
const closeBridge = (): CloseBridge =>
  (window as unknown as { chatbotDesktop?: CloseBridge }).chatbotDesktop || {}

/**
 * 桌面端注入的「多 API」栏（`desktop/page-enhancements.js`）自己维护一份原生
 * DOM 的草稿，React 完全看不见——所以下面的 isDirty() 判不出它有没有改动，
 * 保存也得由它自己来。它通过这个全局对象把两件事交回来。浏览器里没有。
 */
interface SettingsExtras {
  isDirty?: () => boolean
  save?: () => Promise<void>
}
const settingsExtras = (): SettingsExtras =>
  (window as unknown as { chatbotSettingsExtras?: SettingsExtras }).chatbotSettingsExtras || {}
/** 注入层在改动状态翻转时派的事件，detail 就是新的 dirty。 */
const EXTRAS_DIRTY_EVENT = 'chatbot-settings-extras-dirty'

/**
 * draft 和已保存的 settings 比一次，判断有没有未保存的改动。
 *
 * 用 JSON 序列化而不是逐字段比：Settings 有三十多个字段，其中四个还是对象数组
 * （styles / search_providers / prompt_templates），手写比较函数每加一个设置项
 * 就得记得改一处，漏了就是「改了却不提示」——正是这个功能要修的毛病。
 *
 * 前提是两边的 key 顺序一致。draft 是 `{...settings}` 浅拷出来的，
 * 数组元素也是 `{...p}`，顺序天然跟着 settings 走，所以成立。
 * 将来如果谁在 draft 里塞了一个 settings 没有的键，这里会恒判为「有改动」——
 * 宁可多问一次，也别静默丢改动。
 */
function isDirty(draft: Settings | null, saved: Settings | null): boolean {
  if (!draft || !saved) return false
  return JSON.stringify(draft) !== JSON.stringify(saved)
}

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
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [section, setSection] = useState<SectionKey>('chat')
  // 正在检测的搜索配置 id，以及每套配置最近一次的检测结果。
  const [testingId, setTestingId] = useState('')
  const [testResults, setTestResults] = useState<Record<string, SearchTestResult>>({})
  // 当前展开的模型选择器。'chat' 是那一栏，搜索配置用它自己的 id。
  const [pickerFor, setPickerFor] = useState('')
  // 弹窗尺寸：null 表示用 CSS 里的默认大小。最大化和手动尺寸都不记忆，
  // 每次打开都回到默认，这是用户明确要的。
  const [modalSize, setModalSize] = useState<{ w: number; h: number } | null>(null)
  const [maximized, setMaximized] = useState(false)
  // 未保存改动的确认框。null 表示没弹；'close' 是只关设置，'quit' 是连程序一起退。
  const [confirmClose, setConfirmClose] = useState<null | 'close' | 'quit'>(null)
  // 「多 API」栏有没有未保存的改动。它不在 draft 里，只能等注入层派事件过来。
  const [extrasDirty, setExtrasDirty] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  // 「关于与更新」那一栏的红点。面板自己也订阅一份，两处互不影响。
  const { hasUpdate } = useUpdateState()

  useEffect(() => {
    if (!settingsOpen) setDraft(null)
    else if (settings && !draft) {
      // styles 里的对象也要拷一层，否则编辑风格会直接改到 store 里的数据。
      setDraft({
        ...settings,
        models: [...settings.models],
        styles: settings.styles.map((s) => ({ ...s })),
        prompt_templates: (settings.prompt_templates || []).map((t) => ({ ...t })),
        search_providers: (settings.search_providers || []).map((p) => ({ ...p })),
      })
    }
  }, [settingsOpen, settings, draft])

  // 每次重新打开都回到第一栏，避免上次停在「诊断」这种角落里。
  useEffect(() => {
    if (settingsOpen) {
      setSection('chat')
      // 模型选择器里的清单是按当时的地址和密钥拉的，重开时一律收起重来。
      setPickerFor('')
      setModalSize(null)
      setMaximized(false)
      setConfirmClose(null)
      setExtrasDirty(false)
      setSaveError('')
    }
  }, [settingsOpen])

  // 注入层是异步装配的（要先去主进程读一次 API 配置），装好才会派事件，
  // 所以监听挂在组件上而不是跟着 settingsOpen 走，免得错过第一次通知。
  useEffect(() => {
    const onExtras = (event: Event) =>
      setExtrasDirty(Boolean((event as CustomEvent<boolean>).detail))
    window.addEventListener(EXTRAS_DIRTY_EVENT, onExtras)
    return () => window.removeEventListener(EXTRAS_DIRTY_EVENT, onExtras)
  }, [])

  // 关窗前问不问，取决于两份草稿里任意一份有改动。前面那个 settingsOpen
  // 不能去掉：设置一关就必须报 false，否则主进程会认为窗口永远不能关。
  const dirty = settingsOpen && (isDirty(draft, settings) || extrasDirty)

  // 把「有没有未保存的改动」同步给主进程，它据此决定点窗口关闭按钮时要不要先问。
  // 设置一关就必然报 false（dirty 里带了 settingsOpen 这个条件），
  // 漏了这一下窗口会永远关不掉。
  useEffect(() => {
    closeBridge().setSettingsDirty?.(dirty)
  }, [dirty])

  // 组件卸载时兜一次。正常路径上上面那个 effect 已经报过 false 了，
  // 但页面整体被替换掉时不会重跑，这里补上。
  useEffect(() => () => closeBridge().setSettingsDirty?.(false), [])

  // 主进程拦下窗口关闭按钮后回调这里，弹的是同一个确认框，只是按「保存」
  // 之后要继续把窗口关掉。
  useEffect(() => {
    const off = closeBridge().onCloseRequested?.(() => setConfirmClose('quit'))
    return off
  }, [])

  if (!settingsOpen || !draft) return null

  const sections = SECTIONS.filter((item) => !item.desktopOnly || isDesktop())

  const patch = (p: Partial<Settings>) => setDraft((d) => (d ? { ...d, ...p } : d))

  /** 展开／收起模型选择器。同一时刻只开一个，免得几份清单同时在拉。 */
  const togglePicker = (key: string) => setPickerFor((cur) => (cur === key ? '' : key))

  /** 把当前填的地址和密钥包成一个上游，给搜索配置、图片这种单来源的地方用。 */
  const singleSource = (id: string, name: string, baseUrl: string, apiKey: string): ModelSource[] =>
    (baseUrl.trim() ? [{ id, name, baseUrl, resolveKey: async () => apiKey }] : [])

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

  // 1.2.19 起图片渠道并进了桌面端的「多 API」，这里原来那套增删改的辅助函数
  // 连同 UI 一起删了。绘画的渠道/模型改在多 API 面板里配，见 docs/07 §4。

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
    if (saving) return
    setSaveError('')
    setSaving(true)
    try {
      // 多 API 那一栏由桌面注入层自己存，先存它再存普通设置——顺序和以前
      // 劫持保存按钮时一致。它失败就整体不往下走，窗口也不关。
      try {
        await settingsExtras().save?.()
      } catch (error) {
        window.alert(`保存多 API 设置失败：${(error as Error).message}`)
        throw error
      }
      // 确保 default_model 在列表中
      const d = { ...draft }
      if (!d.models.includes(d.default_model) && d.models.length) {
        d.default_model = d.models[0]
      }
      await saveSettings(d)
      setSettingsOpen(false)
    } catch (error) {
      setSaveError(`保存失败：${(error as Error).message}`)
      throw error
    } finally {
      setSaving(false)
    }
  }

  /**
   * 想关掉设置弹窗（点 X、点遮罩、点「取消」）。有未保存的改动就先弹确认框，
   * 没有就直接关——没改过还要问一句是纯添乱。
   */
  const requestClose = () => {
    if (saving) return
    if (dirty) setConfirmClose('close')
    else setSettingsOpen(false)
  }

  /** 确认框的「保存」。quit 那一路存完还要把窗口继续关掉。 */
  const confirmSave = async () => {
    const mode = confirmClose
    setConfirmClose(null)
    try {
      await save()
    } catch {
      // 存不上就别把窗口关了，否则用户既没存成也没得改。
      // 具体错误由 saveSettings 走 store 的 error 通道呈现。
      if (mode === 'quit') closeBridge().resolveClose?.('cancel')
      return
    }
    if (mode === 'quit') closeBridge().resolveClose?.('proceed')
  }

  /** 确认框的「不保存」：丢掉 draft 直接走。 */
  const confirmDiscard = () => {
    const mode = confirmClose
    setConfirmClose(null)
    setSettingsOpen(false)
    if (mode === 'quit') closeBridge().resolveClose?.('proceed')
  }

  /** 确认框的「取消」：留在设置里接着改。窗口那一路要告诉主进程别关了。 */
  const confirmCancel = () => {
    const mode = confirmClose
    setConfirmClose(null)
    if (mode === 'quit') closeBridge().resolveClose?.('cancel')
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
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
            <button className="icon-btn" onClick={requestClose}><X size={17} /></button>
          </div>
        </div>

        {saveError && <div className="error-banner" role="alert">{saveError}</div>}
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
                <label>图片尺寸</label>
                <input
                  value={draft.image_size}
                  placeholder="1920x1080"
                  onChange={(e) => patch({ image_size: e.target.value })}
                />
                <div className="hint">
                  文生图的输出尺寸；图片编辑默认「跟随原图」，要固定尺寸得在图片页单独选。
                </div>
              </div>
              <div className="hint">
                1.2.19 起图片渠道并进了「多 API」：在那里添加渠道、获取模型清单，
                把绘画模型的用途标成「图片」，它就会出现在图片页的模型选择器里。
                用哪家渠道、哪个模型都在图片页当场选，不在这里配。
              </div>
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
          <button className="btn-ghost" onClick={requestClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={() => { void save().catch(() => {}) }}>
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

      {/* 未保存改动的确认框。套在设置弹窗的遮罩里，不再叠一层遮罩——
          两层半透明黑叠起来会明显变暗，像是出了什么错。 */}
      {confirmClose && (
        <div className="confirm-dirty" role="dialog" aria-modal="true">
          <h3>设置还没保存</h3>
          <p>
            {confirmClose === 'quit'
              ? '有改动没有保存。要先保存再关闭软件吗？'
              : '有改动没有保存。关掉这个窗口就会丢失。'}
          </p>
          <div className="confirm-dirty-actions">
            <button className="btn-ghost" onClick={confirmCancel}>取消</button>
            <button className="btn-ghost" onClick={confirmDiscard}>不保存</button>
            <button className="btn-primary" disabled={saving} onClick={confirmSave}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
