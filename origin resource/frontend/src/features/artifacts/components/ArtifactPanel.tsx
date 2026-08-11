import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Copy, Download, History, X } from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useStore } from '../../../store'
import { artifactTitle, collectVersions, type ArtifactVersion } from '../artifactVersions'

function stamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 在聊天区右侧安全预览模型输出的 HTML/SVG 代码，并可回看历史版本。 */
export function ArtifactPanel() {
  const artifact = useStore((s) => s.artifact)
  const setArtifact = useStore((s) => s.setArtifact)
  const tree = useStore((s) => s.tree)
  const theme = useStore((s) => s.settings?.theme)
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const [copied, setCopied] = useState(false)
  // 停在最新版时跟随新版本，用户手动往回翻则停住，跟消息列表的跟随滚动同一个思路。
  const stickLatest = useRef(true)

  const language = artifact?.language || ''
  const versions = useMemo(
    () => (language ? collectVersions(tree, language) : []),
    [tree, language],
  )

  const index = useMemo(() => {
    if (!artifact) return -1
    const byId = versions.findIndex((v) => v.versionId === artifact.versionId)
    if (byId >= 0) return byId
    // 正文改过一个字，版本号里的块序号就可能挪位，退一步按代码原文找。
    return versions.findIndex((v) => v.code === artifact.code)
  }, [versions, artifact])

  const show = (v: ArtifactVersion) =>
    setArtifact({
      id: v.versionId,
      title: artifactTitle(v.language),
      language: v.language,
      code: v.code,
      versionId: v.versionId,
    })

  useEffect(() => {
    const latest = versions[versions.length - 1]
    if (!artifact || !latest || !stickLatest.current) return
    // 流式输出时最新那版的代码还在长，versionId 没变也要把新内容顶上来。
    if (latest.versionId !== artifact.versionId || latest.code !== artifact.code) show(latest)
  }, [versions])

  const srcDoc = useMemo(() => {
    if (!artifact) return ''
    if (artifact.language === 'svg') {
      return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff">${artifact.code}</body></html>`
    }
    return artifact.code
  }, [artifact])

  if (!artifact) return null

  const goto = (i: number) => {
    if (i < 0 || i >= versions.length) return
    stickLatest.current = i === versions.length - 1
    show(versions[i])
  }

  const current = index >= 0 ? versions[index] : null
  const versionLabel = index >= 0 ? `v${index + 1}` : ''
  const ext = artifact.language === 'svg' ? 'svg' : 'html'

  return (
    <div className="artifact-panel">
      <div className="artifact-header">
        <span className="title">{artifact.title}</span>
        {versions.length > 1 && (
          <span className="artifact-versions" title={current ? `生成于 ${stamp(current.created_at)}` : undefined}>
            <History size={13} />
            <button disabled={index <= 0} title="上一版" onClick={() => goto(index - 1)}>
              <ChevronLeft size={14} />
            </button>
            <span className="artifact-version-label">
              {index >= 0 ? `${index + 1} / ${versions.length}` : `— / ${versions.length}`}
            </span>
            <button
              disabled={index < 0 || index >= versions.length - 1}
              title="下一版"
              onClick={() => goto(index + 1)}
            >
              <ChevronRight size={14} />
            </button>
          </span>
        )}
        <div className="artifact-tabs">
          <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>预览</button>
          <button className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}>代码</button>
        </div>
        <div className="artifact-actions">
          <button
            className="icon-btn"
            title="复制代码"
            onClick={() => {
              navigator.clipboard.writeText(artifact.code)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <button
            className="icon-btn"
            title="下载"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([artifact.code], { type: 'text/plain;charset=utf-8' }))
              const a = document.createElement('a')
              a.href = url
              // 带上版本号，连着存几版才不会互相覆盖。
              a.download = versionLabel ? `artifact-${versionLabel}.${ext}` : `artifact.${ext}`
              a.click()
              setTimeout(() => URL.revokeObjectURL(url), 1000)
            }}
          >
            <Download size={15} />
          </button>
          <button className="icon-btn" title="关闭" onClick={() => setArtifact(null)}>
            <X size={16} />
          </button>
        </div>
      </div>
      {versions.length > 1 && index >= 0 && index < versions.length - 1 && (
        <div className="artifact-oldver">
          正在看第 {index + 1} 版（共 {versions.length} 版）
          <button onClick={() => goto(versions.length - 1)}>回到最新</button>
        </div>
      )}
      <div className="artifact-body">
        {tab === 'preview' ? (
          <iframe title="artifact-preview" sandbox="allow-scripts" srcDoc={srcDoc} />
        ) : (
          <div className="artifact-code">
            <SyntaxHighlighter
              language={artifact.language}
              style={theme === 'dark' ? oneDark : oneLight}
              customStyle={{ background: 'transparent', margin: 0, padding: '14px' }}
            >
              {artifact.code}
            </SyntaxHighlighter>
          </div>
        )}
      </div>
    </div>
  )
}
