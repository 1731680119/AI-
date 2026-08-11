import { useEffect, useState } from 'react'
import {
  Activity, Brain, Globe, Image, LayoutTemplate, MessageSquare,
  Paperclip, Palette, Plus, Server, Trash2, X,
} from 'lucide-react'
import { useStore } from '../../../store'
import type { ChatStyle, PromptTemplate, Settings } from '../../../types'
import { DiagnosticsPanel } from '../../diagnostics/components/DiagnosticsPanel'
import { MemoryPanel } from './MemoryPanel'

/** 桌面端注入的「多 API」分区只在 Electron 里有意义，浏览器里不显示这一栏。 */
const isDesktop = () => Boolean((window as unknown as { chatbotDesktop?: unknown }).chatbotDesktop)

type SectionKey =
  | 'chat' | 'api' | 'context' | 'search' | 'memory'
  | 'styles' | 'templates' | 'files' | 'images' | 'diagnostics'

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

  useEffect(() => {
    if (settingsOpen && settings) {
      // styles 里的对象也要拷一层，否则编辑风格会直接改到 store 里的数据。
      setDraft({
        ...settings,
        models: [...settings.models],
        styles: settings.styles.map((s) => ({ ...s })),
        prompt_templates: (settings.prompt_templates || []).map((t) => ({ ...t })),
      })
    }
  }, [settingsOpen, settings])

  // 每次重新打开都回到第一栏，避免上次停在「诊断」这种角落里。
  useEffect(() => {
    if (settingsOpen) setSection('chat')
  }, [settingsOpen])

  if (!settingsOpen || !draft) return null

  const sections = SECTIONS.filter((item) => !item.desktopOnly || isDesktop())

  const patch = (p: Partial<Settings>) => setDraft((d) => (d ? { ...d, ...p } : d))

  const addModel = () => {
    const name = newModel.trim()
    if (!name || draft.models.includes(name)) return
    patch({ models: [...draft.models, name] })
    setNewModel('')
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
      <div className="modal modal-settings">
        <div className="modal-header">
          <h2>设置</h2>
          <button className="icon-btn" onClick={() => setSettingsOpen(false)}><X size={17} /></button>
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
                <label>模型列表</label>
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
                <label>API 地址（Base URL）</label>
                <input
                  value={draft.search_base_url}
                  placeholder="https://api.deepseek.com"
                  disabled={!draft.tools_enabled}
                  onChange={(e) => patch({ search_base_url: e.target.value })}
                />
                <div className="hint">
                  搜索走独立上游，与聊天接口无关。目前仅 DeepSeek 的 Responses 接口内置搜索。
                </div>
              </div>

              <div className="field">
                <label>API 密钥</label>
                <input
                  type="password"
                  value={draft.search_api_key}
                  placeholder="sk-…"
                  disabled={!draft.tools_enabled}
                  onChange={(e) => patch({ search_api_key: e.target.value })}
                />
                <div className="hint">留空则不会把搜索工具提供给模型</div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label>搜索模型</label>
                  <input
                    value={draft.search_model}
                    placeholder="deepseek-v4-flash"
                    disabled={!draft.tools_enabled}
                    onChange={(e) => patch({ search_model: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>单次搜索输出上限（Tokens）</label>
                  <input
                    type="number" min={1000} max={32000} step={500}
                    disabled={!draft.tools_enabled}
                    value={draft.search_max_output_tokens}
                    onChange={(e) => patch({ search_max_output_tokens: parseInt(e.target.value) || 4000 })}
                  />
                  <div className="hint">调低容易让思考占满预算而拿不到结论</div>
                </div>
              </div>
              <div className="hint">
                一次联网问答的输入量约为普通对话的十几倍，按量计费时请留意消耗。
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
                <label>API 地址（Base URL）</label>
                <input
                  value={draft.image_base_url}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => patch({ image_base_url: e.target.value })}
                />
              </div>

              <div className="field">
                <label>API 密钥</label>
                <input
                  type="password"
                  value={draft.image_api_key}
                  placeholder="sk-…"
                  onChange={(e) => patch({ image_api_key: e.target.value })}
                />
              </div>

              <div className="field">
                <label>图片模型</label>
                <input
                  value={draft.image_model}
                  placeholder="gpt-image-2"
                  onChange={(e) => patch({ image_model: e.target.value })}
                />
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
            </section>

            <section className="settings-pane" hidden={section !== 'diagnostics'}>
              <h3 className="settings-section-title">诊断</h3>
              <DiagnosticsPanel />
            </section>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-ghost" onClick={() => setSettingsOpen(false)}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
