import { memo, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Check, Copy, Download, FileCode2 } from 'lucide-react'
import { useStore } from '../../../store'
import { ARTIFACT_LANGS, artifactTitle, versionIdOf } from '../../artifacts/artifactVersions'

const MIN_ARTIFACT_LINES = 6

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? '已复制' : '复制'}
    </button>
  )
}

function CodeBlock({ language, code, versionId }: { language: string; code: string; versionId?: string }) {
  const theme = useStore((s) => s.settings?.theme)
  const setArtifact = useStore((s) => s.setArtifact)
  const lines = code.split('\n').length

  const open = () =>
    setArtifact({
      id: versionId || `artifact-${Date.now()}`,
      title: artifactTitle(language),
      language,
      code,
      versionId,
    })

  // HTML/SVG 且行数足够 → 显示为 Artifact 卡片
  if (ARTIFACT_LANGS.has(language) && lines >= MIN_ARTIFACT_LINES) {
    return (
      <div className="artifact-card" onClick={open}>
        <div className="icon"><FileCode2 size={18} /></div>
        <div className="info">
          <div className="name">{artifactTitle(language)}</div>
          <div className="desc">点击打开预览 · {lines} 行</div>
        </div>
      </div>
    )
  }

  return (
    <div className="code-block">
      <div className="code-header">
        <span>{language || 'text'}</span>
        <div className="actions">
          {ARTIFACT_LANGS.has(language) && (
            <button onClick={open}>预览</button>
          )}
          <button
            onClick={() => {
              const blob = new Blob([code], { type: 'text/plain' })
              const a = document.createElement('a')
              a.href = URL.createObjectURL(blob)
              a.download = `code.${language || 'txt'}`
              a.click()
            }}
          >
            <Download size={13} />
          </button>
          <CopyButton text={code} />
        </div>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={theme === 'dark' ? oneDark : oneLight}
        customStyle={{ background: 'transparent', padding: '12px 14px' }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

export const Markdown = memo(function Markdown({
  content,
  messageId,
}: { content: string; messageId?: string }) {
  const components = useMemo(
    () => ({
      code({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { className?: string }) {
        const match = /language-(\w+)/.exec(className || '')
        const code = String(children).replace(/\n$/, '')
        // 行内代码
        if (!match && !code.includes('\n')) {
          return <code {...props}>{children}</code>
        }
        const language = match?.[1] || ''
        // 临时消息还没有正式 id，等落库后版本号才稳定，这之前先不参与版本历史。
        const versionId =
          messageId && !messageId.startsWith('temp-') && ARTIFACT_LANGS.has(language)
            ? versionIdOf(messageId, content, language, code)
            : undefined
        return <CodeBlock language={language} code={code} versionId={versionId} />
      },
      // pre 直接透传，避免嵌套 pre
      pre({ children }: { children?: React.ReactNode }) {
        return <>{children}</>
      },
    }),
    // 版本号要按最新正文算，正文变了这份 components 必须重建。
    [content, messageId],
  )

  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
})
