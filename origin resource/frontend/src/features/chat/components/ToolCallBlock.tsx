import { useState } from 'react'
import {
  AlertCircle, Brain, ChevronDown, ExternalLink, Globe, Loader2, Search, Terminal,
} from 'lucide-react'
import type { ToolCall } from '../../../types'

const TOOL_LABELS: Record<string, string> = {
  web_search: '联网搜索',
  remember: '长期记忆',
  run_code: '运行代码',
}

/** 从 URL 取域名。后端在 open_page 的 URL 尾部追加了 #ws_call_id，解析时会被忽略。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 折叠标题上的一行摘要：跑动时显示当前动作，结束后显示来源数量。 */
function summary(call: ToolCall): string {
  if (call.tool === 'run_code') {
    if (call.awaitingConfirm) return '等待你确认'
    if (call.error) return '未执行'
    if (call.running) return '正在运行…'
    const d = call.display
    if (d?.timed_out) return '超时被中止'
    if (d?.returncode) return `出错退出（代码 ${d.returncode}）`
    const ms = d?.elapsed_ms
    return ms == null ? '已运行' : `运行完成 · ${(ms / 1000).toFixed(1)}s`
  }
  if (call.tool === 'remember') {
    if (call.error) return '记录失败'
    if (call.running) return '正在记住…'
    return call.display?.duplicate ? '此前已记住' : '已记住'
  }
  if (call.error) return '搜索失败'
  if (call.running) {
    const last = call.progress?.[call.progress.length - 1]
    if (!last) return '正在准备…'
    if (last.action === 'open_page') return `正在阅读 ${hostOf(last.url)}`
    const first = last.queries[0] || ''
    const more = last.queries.length > 1 ? ` 等 ${last.queries.length} 个查询` : ''
    return `正在搜索「${first}」${more}`
  }
  const count = call.display?.sources?.length ?? 0
  return count ? `参考了 ${count} 个来源` : '已完成'
}

/**
 * 代码执行的详情：代码原文 + 两路输出。
 * 代码取 display.code 而非 arguments.code——用户在确认框里改过的话，跑的是改后的版本。
 */
function CodeExecBody({ call }: { call: ToolCall }) {
  const d = call.display
  const code = d?.code || (typeof call.arguments.code === 'string' ? call.arguments.code : '')
  const purpose = typeof call.arguments.purpose === 'string' ? call.arguments.purpose : ''
  return (
    <>
      {purpose && <div className="tool-query">用途：{purpose}</div>}
      {code && <pre className="tool-code">{code}</pre>}
      {d?.timed_out && (
        <div className="tool-error">运行超时，进程已被中止。输出只到中止那一刻。</div>
      )}
      {d?.stdout && (
        <div className="tool-output">
          <div className="tool-output-label">输出</div>
          <pre>{d.stdout}</pre>
        </div>
      )}
      {d?.stderr && (
        <div className="tool-output err">
          <div className="tool-output-label">错误输出</div>
          <pre>{d.stderr}</pre>
        </div>
      )}
      {/* 跑完了、没超时、两路都空：说明代码没打印任何东西，明说比留白好。 */}
      {!call.running && !call.awaitingConfirm && !call.error && d && !d.stdout && !d.stderr
        && !d.timed_out && <div className="tool-output-empty">没有任何输出</div>}
    </>
  )
}

export function ToolCallBlock({ call }: { call: ToolCall }) {
  const isCode = call.tool === 'run_code'
  // 代码执行默认展开：跑了什么、出了什么，是这类调用里最该被看到的部分。
  const [open, setOpen] = useState(isCode)
  const label = TOOL_LABELS[call.tool] || call.tool
  const sources = call.display?.sources || []
  const query = typeof call.arguments.query === 'string' ? call.arguments.query : ''
  const isMemory = call.tool === 'remember'

  return (
    <div className={`tool-block${call.error ? ' failed' : ''}`}>
      <button className="tool-toggle" onClick={() => setOpen((v) => !v)}>
        {call.running || call.awaitingConfirm
          ? <Loader2 size={13} className="spin" />
          : call.error ? <AlertCircle size={13} />
          : isCode ? <Terminal size={13} />
          : isMemory ? <Brain size={13} /> : <Search size={13} />}
        <span className="tool-name">{label}</span>
        <span className="tool-summary">{summary(call)}</span>
        <ChevronDown
          size={13}
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
        />
      </button>

      {open && (
        <div className="tool-body">
          {!isCode && query && <div className="tool-query">查询：{query}</div>}

          {call.error && <div className="tool-error">{call.error}</div>}

          {isCode && <CodeExecBody call={call} />}

          {sources.length > 0 && (
            <ul className="tool-sources">
              {sources.map((s) => (
                <li key={s.url}>
                  <Globe size={11} />
                  <a href={s.url} target="_blank" rel="noreferrer noopener">
                    {s.host}
                  </a>
                  <ExternalLink size={10} className="tool-source-icon" />
                </li>
              ))}
            </ul>
          )}

          {/* 记忆只有一句话，直接显示；折叠起来反而看不到记了什么。 */}
          {isMemory && call.display?.text && (
            <div className="tool-memory">{call.display.text}</div>
          )}

          {/* 搜索结果原文默认不展开，避免把回答顶到屏幕外。 */}
          {!isMemory && call.display?.text && (
            <details className="tool-raw">
              <summary>搜索结论原文</summary>
              <div className="tool-raw-body">{call.display.text}</div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
