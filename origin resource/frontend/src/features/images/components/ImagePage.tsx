import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles, Wand2, Upload, X, Download, FileOutput, Loader2, ImagePlus, ChevronDown, Check,
  ArrowLeft,
} from 'lucide-react'
import { useStore } from '../../../store'
import { imageFileUrl } from '../../../services/api'
import { useFileDrop } from '../../../hooks/useFileDrop'
import { useDesktopChannels, groupByChannel, resolveChannelName } from '../../../hooks/useDesktopChannels'
import { ExportDialog } from './ExportDialog'

/** 参考图上限，与后端 MAX_REFERENCE_IMAGES 保持一致。 */
const MAX_REFERENCES = 4

/** 图片编辑可选的固定输出尺寸，不选则跟随原图。 */
const EDIT_SIZE_PRESETS = ['1024x1024', '1536x1024', '1024x1536']

/** 图片工作区：未选择历史记录时显示任务表单，选择后显示任务详情。 */
export function ImagePage() {
  const settings = useStore((s) => s.settings)
  const images = useStore((s) => s.images)
  const selectedImageId = useStore((s) => s.selectedImageId)
  const imageBusy = useStore((s) => s.imageBusy)
  const generateImages = useStore((s) => s.generateImages)
  const editImage = useStore((s) => s.editImage)
  const saveSettings = useStore((s) => s.saveSettings)
  const imageApiId = useStore((s) => s.imageApiId)
  const setImageApiId = useStore((s) => s.setImageApiId)
  const closeImageDetail = useStore((s) => s.closeImageDetail)

  // 表单内容存在 store 里，切走再回来还在（见 ImageDraft 的说明）。
  const draft = useStore((s) => s.imageDraft)
  const patch = useStore((s) => s.patchImageDraft)
  const { tab, prompt, negative, count, srcFile, srcPreview, refs, refHint, editSize } = draft

  // 正在导出的图片文件名，null 表示没开导出对话框。这个是纯粹的一次性 UI 状态，
  // 不属于「用户填的表单」，所以留在组件里。
  const [exporting, setExporting] = useState<string | null>(null)
  const [modelMenu, setModelMenu] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const refInput = useRef<HTMLInputElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(
    () => images.find((r) => r.id === selectedImageId) ?? null,
    [images, selectedImageId],
  )

  // 桌面端按渠道分组列绘画模型：只列渠道模型清单里标成 image 用途的那些。
  // 和输入框那个选择器是同一套（见 Composer），区别只有 capability 和
  // 写回的字段（image_model / imageApiId）。
  const { supported: channelsSupported, channels, refresh: refreshChannels } = useDesktopChannels()
  const imageGroups = groupByChannel(channels, 'image')
  const imageModel = settings?.image_model || ''
  // 同 Composer：imageApiId 初始为 null，但请求照样发得出去，所以按主进程那套
  // 优先级把「真正会被调用的那家」算出来显示，别让渠道名空着。
  const activeChannelName = resolveChannelName(imageGroups, imageApiId, imageModel)

  // 点击外部关闭模型菜单。
  useEffect(() => {
    if (!modelMenu) return
    const onClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenu(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [modelMenu])

  const openModelMenu = () => {
    // 每次打开都重新拉：渠道的模型清单可能刚在设置页里被获取或增删过。
    if (!modelMenu) void refreshChannels()
    setModelMenu((v) => !v)
  }

  /** 选定「某家渠道的某个绘画模型」：模型名进设置（跨重启），渠道 id 只记本次运行。 */
  const pickModel = (name: string, apiId: string) => {
    if (settings && name !== imageModel) void saveSettings({ ...settings, image_model: name })
    setImageApiId(apiId)
    setModelMenu(false)
  }

  const pickFile = (f: File | null) => {
    if (srcPreview) URL.revokeObjectURL(srcPreview)
    patch({ srcFile: f, srcPreview: f ? URL.createObjectURL(f) : null })
  }

  const addRefs = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return
    // 必须在这里就把 FileList 拷成数组：调用方紧接着会清空 input.value，
    // 而 FileList 是活引用，晚一步再取就已经是空的了。
    const incoming = Array.from(files)
    const room = Math.max(0, MAX_REFERENCES - refs.length)
    const picked = incoming.slice(0, room)
    if (picked.length === 0) {
      patch({ refHint: `参考图最多 ${MAX_REFERENCES} 张，多余的已忽略` })
      return
    }
    const items = picked.map((file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      note: '',
      preview: URL.createObjectURL(file),
    }))
    patch({
      refs: [...refs, ...items],
      refHint: picked.length < incoming.length
        ? `参考图最多 ${MAX_REFERENCES} 张，多余的已忽略`
        : '',
    })
  }

  const removeRef = (id: string) => {
    const target = refs.find((item) => item.id === id)
    if (target) URL.revokeObjectURL(target.preview)
    patch({ refs: refs.filter((item) => item.id !== id), refHint: '' })
  }

  const updateRefNote = (id: string, note: string) => {
    patch({ refs: refs.map((item) => (item.id === id ? { ...item, note } : item)) })
  }

  // 两个投放区各管各的：主图只取第一张并替换，参考图追加（仍受 4 张上限约束）。
  const mainDrop = useFileDrop({
    accept: 'image',
    disabled: imageBusy,
    onFiles: (files) => pickFile(files[0]),
  })
  const refDrop = useFileDrop({
    accept: 'image',
    disabled: imageBusy,
    onFiles: (files) => addRefs(files),
  })

  const canSubmit =
    !imageBusy && prompt.trim().length > 0 && (tab === 'generate' || srcFile !== null)

  const submit = async () => {
    if (!canSubmit) return
    if (tab === 'generate') {
      await generateImages({ prompt: prompt.trim(), negative_prompt: negative.trim(), n: count })
    } else if (srcFile) {
      await editImage(
        srcFile,
        { prompt: prompt.trim(), negative_prompt: negative.trim(), size: editSize },
        refs.map((item) => ({ file: item.file, note: item.note.trim() })),
      )
    }
  }

  // 查看历史记录详情
  if (selected) {
    return (
      <div className="image-page">
        <div className="image-detail">
          {/* 返回只清 selectedImageId，草稿原样留着。没有这个按钮的话，回表单
              就只剩侧边栏那个「新建图片」，而它会把辛苦填好的草稿清空。 */}
          <button className="image-detail-back" onClick={closeImageDetail}>
            <ArrowLeft size={14} />
            返回编辑
          </button>
          <div className="image-detail-meta">
            <span className={`badge ${selected.mode}`}>
              {selected.mode === 'edit' ? '图片编辑' : '文生图'}
            </span>
            {selected.model && <span className="meta-chip">{selected.model}</span>}
            {selected.size && <span className="meta-chip">{selected.size}</span>}
            {selected.quality && <span className="meta-chip">{selected.quality}</span>}
            <span className="meta-chip">{new Date(selected.created_at).toLocaleString()}</span>
          </div>
          {selected.prompt && <p className="image-detail-prompt">{selected.prompt}</p>}
          {selected.negative_prompt && (
            <p className="image-detail-negative">避免：{selected.negative_prompt}</p>
          )}
          {selected.reference_names && selected.reference_names.length > 0 && (
            <div className="image-detail-references">
              <span className="reference-title">
                参考图 {selected.reference_names.length} 张
              </span>
              <ul>
                {selected.reference_names.map((name, index) => (
                  <li key={`${name}-${index}`}>
                    <span className="reference-file">{name}</span>
                    {selected.reference_notes?.[index] && (
                      <span className="reference-desc">{selected.reference_notes[index]}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="image-grid">
            {selected.files.map((name) => (
              <figure key={name} className="image-card">
                <img src={imageFileUrl(name)} alt={selected.prompt} />
                <div className="image-card-actions">
                  <button
                    className="card-action-btn"
                    onClick={() => setExporting(name)}
                    title="导出为其它格式（TIFF / JPEG / PDF…）"
                  >
                    <FileOutput size={15} />
                  </button>
                  <a
                    className="card-action-btn download-btn"
                    href={imageFileUrl(name)}
                    download={name}
                    title="下载原图"
                  >
                    <Download size={15} />
                  </a>
                </div>
              </figure>
            ))}
          </div>
        </div>
        {exporting && <ExportDialog name={exporting} onClose={() => setExporting(null)} />}
      </div>
    )
  }

  // 新建生成表单
  return (
    <div className="image-page">
      <div className="image-form">
        <h2 className="image-form-title">
          <Sparkles size={20} />
          AI 图片工坊
        </h2>

        <div className="image-tabs">
          <button
            className={tab === 'generate' ? 'active' : ''}
            onClick={() => patch({ tab: 'generate' })}
          >
            <Sparkles size={14} />
            文生图
          </button>
          <button
            className={tab === 'edit' ? 'active' : ''}
            onClick={() => patch({ tab: 'edit' })}
          >
            <Wand2 size={14} />
            图片编辑
          </button>
        </div>

        {tab === 'edit' && (
          <>
            <label className="image-label">主图（会被修改并输出）</label>
            <div
              className={`image-upload-zone${mainDrop.dragging ? ' drag-over' : ''}`}
              {...mainDrop.dropProps}
            >
              {srcPreview ? (
                <div className="image-upload-preview">
                  <img src={srcPreview} alt="主图" />
                  <button className="icon-btn remove" title="移除" onClick={() => pickFile(null)}>
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <button className="upload-placeholder" onClick={() => fileInput.current?.click()}>
                  <Upload size={20} />
                  <span>上传要编辑的图片，或直接拖进来</span>
                </button>
              )}
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
            </div>

            <label className="image-label">
              参考图（可选，最多 {MAX_REFERENCES} 张）
            </label>
            <div
              className={`reference-zone${refDrop.dragging ? ' drag-over' : ''}`}
              {...refDrop.dropProps}
            >
              {refs.length > 0 && (
                <div className="reference-list">
                  {refs.map((item, index) => (
                    <div key={item.id} className="reference-item">
                      <div className="reference-thumb">
                        <img src={item.preview} alt={`参考图 ${index + 1}`} />
                        <span className="reference-index">{index + 1}</span>
                        <button
                          className="icon-btn remove"
                          title="移除这张参考图"
                          onClick={() => removeRef(item.id)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                      <input
                        className="reference-note"
                        type="text"
                        placeholder="想参考它的什么？如配色 / 发型 / 材质"
                        value={item.note}
                        onChange={(e) => updateRefNote(item.id, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              )}
              {refs.length < MAX_REFERENCES && (
                <button
                  className="reference-add"
                  onClick={() => refInput.current?.click()}
                >
                  <ImagePlus size={16} />
                  <span>添加参考图，或直接拖进来</span>
                </button>
              )}
              <input
                ref={refInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  addRefs(e.target.files)
                  e.target.value = ''
                }}
              />
              <p className="reference-hint">
                {refHint || '参考图只用于提取特征（风格、配色、材质等），不会被直接输出。'}
              </p>
            </div>
          </>
        )}

        <label className="image-label">提示词</label>
        <textarea
          className="image-textarea"
          rows={4}
          placeholder={tab === 'generate' ? '描述你想生成的画面…' : '描述你想如何修改这张图片…'}
          value={prompt}
          onChange={(e) => patch({ prompt: e.target.value })}
        />

        <label className="image-label">负面提示词（可选）</label>
        <textarea
          className="image-textarea"
          rows={2}
          placeholder="不希望出现的内容…"
          value={negative}
          onChange={(e) => patch({ negative: e.target.value })}
        />

        {tab === 'edit' && (
          <>
            <label className="image-label">输出尺寸</label>
            <select
              className="image-size-select"
              value={editSize}
              onChange={(e) => patch({ editSize: e.target.value })}
            >
              <option value="">跟随原图</option>
              {settings?.image_size && (
                <option value={settings.image_size}>
                  设置中的尺寸（{settings.image_size}）
                </option>
              )}
              {EDIT_SIZE_PRESETS.filter((item) => item !== settings?.image_size).map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <p className="reference-hint">
              默认「跟随原图」：不指定尺寸，输出保持原图的大小与比例，设置里的图片尺寸不会生效。
              需要固定尺寸时在上面选一项。
            </p>
          </>
        )}

        <div className="image-form-row">
          {tab === 'generate' && (
            <label className="image-count">
              数量
              <select value={count} onChange={(e) => patch({ count: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          )}

          {/* 模型选择器。文生图和图片编辑共用一个——两边打的是同一个渠道的
              同一个模型，分开选只会让人以为它们能配不一样。 */}
          <div className="model-select image-model-select" ref={modelMenuRef}>
            <button
              className="model-btn"
              title={activeChannelName ? `${activeChannelName} · ${imageModel}` : imageModel}
              onClick={openModelMenu}
            >
              {activeChannelName && <span className="model-btn-channel">{activeChannelName}</span>}
              {imageModel || '选择绘画模型'}
              <ChevronDown size={14} />
            </button>
            {modelMenu && (
              <div className="model-menu model-menu-grouped">
                {imageGroups.length > 0 ? imageGroups.map((group) => (
                  <div className="model-group" key={group.id}>
                    <div className="model-group-title">{group.name}</div>
                    {group.models.map((m) => {
                      // 同名模型可能出现在多家渠道下，所以要连渠道一起比。
                      const active = m === imageModel && group.id === imageApiId
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
                )) : (
                  <div className="model-menu-empty">
                    {channelsSupported
                      ? '还没有可用的绘画模型。去设置的「多 API」里获取模型清单，把绘画模型的用途标成「图片」。'
                      : '绘画模型选择只在桌面端可用。'}
                  </div>
                )}
              </div>
            )}
          </div>

          <span className="image-settings-hint">
            {tab === 'edit' ? (editSize || '跟随原图') : settings?.image_size} ·{' '}
            {settings?.image_quality}
          </span>
          <button className="image-submit" disabled={!canSubmit} onClick={submit}>
            {imageBusy ? (
              <>
                <Loader2 size={15} className="spin" />
                生成中…
              </>
            ) : (
              <>
                <Sparkles size={15} />
                开始生成
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
