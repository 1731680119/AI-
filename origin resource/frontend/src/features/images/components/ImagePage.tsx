import { useMemo, useRef, useState } from 'react'
import { Sparkles, Wand2, Upload, X, Download, Loader2, ImagePlus } from 'lucide-react'
import { useStore } from '../../../store'
import { imageFileUrl } from '../../../services/api'

/** 参考图上限，与后端 MAX_REFERENCE_IMAGES 保持一致。 */
const MAX_REFERENCES = 4

/** 图片编辑可选的固定输出尺寸，不选则跟随原图。 */
const EDIT_SIZE_PRESETS = ['1024x1024', '1536x1024', '1024x1536']

/** 编辑页里一张待上传的参考图。 */
interface RefItem {
  id: string
  file: File
  note: string
  preview: string
}

/** 图片工作区：未选择历史记录时显示任务表单，选择后显示任务详情。 */
export function ImagePage() {
  const settings = useStore((s) => s.settings)
  const images = useStore((s) => s.images)
  const selectedImageId = useStore((s) => s.selectedImageId)
  const imageBusy = useStore((s) => s.imageBusy)
  const generateImages = useStore((s) => s.generateImages)
  const editImage = useStore((s) => s.editImage)

  const [tab, setTab] = useState<'generate' | 'edit'>('generate')
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [count, setCount] = useState(1)
  const [srcFile, setSrcFile] = useState<File | null>(null)
  const [srcPreview, setSrcPreview] = useState<string | null>(null)
  const [refs, setRefs] = useState<RefItem[]>([])
  const [refHint, setRefHint] = useState('')
  // 空字符串表示「跟随原图」：不向上游传 size，输出保持原图尺寸与比例。
  const [editSize, setEditSize] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const refInput = useRef<HTMLInputElement>(null)

  const selected = useMemo(
    () => images.find((r) => r.id === selectedImageId) ?? null,
    [images, selectedImageId],
  )

  const pickFile = (f: File | null) => {
    if (srcPreview) URL.revokeObjectURL(srcPreview)
    setSrcFile(f)
    setSrcPreview(f ? URL.createObjectURL(f) : null)
  }

  const addRefs = (files: FileList | null) => {
    if (!files || files.length === 0) return
    setRefs((prev) => {
      const room = MAX_REFERENCES - prev.length
      const picked = Array.from(files).slice(0, Math.max(0, room))
      if (picked.length < files.length) {
        setRefHint(`参考图最多 ${MAX_REFERENCES} 张，多余的已忽略`)
      } else {
        setRefHint('')
      }
      return [
        ...prev,
        ...picked.map((file) => ({
          id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          note: '',
          preview: URL.createObjectURL(file),
        })),
      ]
    })
  }

  const removeRef = (id: string) => {
    setRefs((prev) => {
      const target = prev.find((item) => item.id === id)
      if (target) URL.revokeObjectURL(target.preview)
      return prev.filter((item) => item.id !== id)
    })
    setRefHint('')
  }

  const updateRefNote = (id: string, note: string) => {
    setRefs((prev) => prev.map((item) => (item.id === id ? { ...item, note } : item)))
  }

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
                <a
                  className="download-btn"
                  href={imageFileUrl(name)}
                  download={name}
                  title="下载"
                >
                  <Download size={15} />
                </a>
              </figure>
            ))}
          </div>
        </div>
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
          <button className={tab === 'generate' ? 'active' : ''} onClick={() => setTab('generate')}>
            <Sparkles size={14} />
            文生图
          </button>
          <button className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>
            <Wand2 size={14} />
            图片编辑
          </button>
        </div>

        {tab === 'edit' && (
          <>
            <label className="image-label">主图（会被修改并输出）</label>
            <div className="image-upload-zone">
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
                  <span>上传要编辑的图片</span>
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
            <div className="reference-zone">
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
                  <span>添加参考图</span>
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
          onChange={(e) => setPrompt(e.target.value)}
        />

        <label className="image-label">负面提示词（可选）</label>
        <textarea
          className="image-textarea"
          rows={2}
          placeholder="不希望出现的内容…"
          value={negative}
          onChange={(e) => setNegative(e.target.value)}
        />

        {tab === 'edit' && (
          <>
            <label className="image-label">输出尺寸</label>
            <select
              className="image-size-select"
              value={editSize}
              onChange={(e) => setEditSize(e.target.value)}
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
              <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          )}
          <span className="image-settings-hint">
            {settings?.image_model} ·{' '}
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
