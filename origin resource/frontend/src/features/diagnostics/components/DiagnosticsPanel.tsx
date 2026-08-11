import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Download, FolderOpen, Pause, Play, RefreshCw, Search } from 'lucide-react'
import * as api from '../../../services/api'
import type { LogRecord } from '../../../services/api'
import { logAction } from '../../../services/diagnostics'

/** 面板里最多保留的行数。超出丢弃最旧的，避免长时间开着实时流把内存吃满。 */
const MAX_LINES = 2000
/** 实时流的渲染节流间隔。日志爆发时先攒着，一次性 setState，防止界面卡死。 */
const FLUSH_MS = 250

const LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const
const SOURCES = [
  { key: 'backend', label: '后端' },
  { key: 'frontend', label: '界面' },
  { key: 'electron', label: '主进程' },
] as const

interface BundleResult {
  saved: boolean
  path?: string
  reason?: string
  error?: string
  containsSensitive?: boolean
}

/** 桌面端才有的能力。浏览器里跑时这些都不存在，各处调用前都要判空。 */
const desktop = () => (window as unknown as {
  desktop?: {
    openLogFolder?: () => Promise<{ opened: boolean; error: string }>
    exportDiagnosticsBundle?: () => Promise<BundleResult>
    copyToClipboard?: (text: string) => Promise<boolean>
  }
}).desktop

const BUNDLE_FAILURES: Record<string, string> = {
  'backend-unavailable': '后端未启动，已改为打开日志文件夹',
  canceled: '已取消导出',
}

export function DiagnosticsPanel() {
  const [records, setRecords] = useState<LogRecord[]>([])
  const [levels, setLevels] = useState<string[]>(['INFO', 'WARNING', 'ERROR', 'CRITICAL'])
  const [sources, setSources] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [live, setLive] = useState(false)
  const [connected, setConnected] = useState(false)
  const [info, setInfo] = useState<api.SystemInfo | null>(null)
  const [verbose, setVerbose] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  const pending = useRef<LogRecord[]>([])
  const listRef = useRef<HTMLDivElement | null>(null)

  const query = useMemo(
    () => ({ limit: 500, levels, sources, search }),
    [levels, sources, search],
  )

  const reload = useCallback(async () => {
    setBusy('loading')
    try {
      const result = await api.fetchLogs(query)
      setRecords(result.records)
      setVerbose(result.verbose)
    } catch (error) {
      setNotice(`读取日志失败：${(error as Error).message}`)
    } finally {
      setBusy('')
    }
  }, [query])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    api.fetchSystemInfo().then(setInfo).catch(() => setInfo(null))
  }, [])

  // 实时流：SSE 收到的记录先进缓冲，定时批量并入列表。
  useEffect(() => {
    if (!live) return
    const stop = api.streamLogs({ levels, sources }, (record) => {
      pending.current.push(record)
    }, setConnected)

    const timer = setInterval(() => {
      if (!pending.current.length) return
      const batch = pending.current
      pending.current = []
      setRecords((prev) => [...prev, ...batch].slice(-MAX_LINES))
    }, FLUSH_MS)

    return () => {
      stop()
      clearInterval(timer)
      pending.current = []
    }
  }, [live, levels, sources])

  // 实时模式下自动滚到底部，跟着最新日志走。
  useEffect(() => {
    if (!live || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [records, live])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return records
    // 实时流推来的记录没经过后端过滤，这里再筛一遍关键词。
    return records.filter((record) =>
      `${record.message} ${record.logger} ${record.trace_id} ${JSON.stringify(record.fields)}`
        .toLowerCase()
        .includes(needle),
    )
  }, [records, search])

  const toggle = (list: string[], value: string, set: (next: string[]) => void) => {
    set(list.includes(value) ? list.filter((item) => item !== value) : [...list, value])
  }

  const copyRecent = async () => {
    const lines = visible.slice(-500)
    const text = lines.map(formatLine).join('\n')
    logAction('复制最近日志', { lines: lines.length })
    try {
      const bridge = desktop()
      // Electron 的 clipboard 不受焦点与安全上下文限制，桌面端优先走它。
      if (bridge?.copyToClipboard) await bridge.copyToClipboard(text)
      else await navigator.clipboard.writeText(text)
      setNotice(`已复制最近 ${lines.length} 条日志`)
    } catch (error) {
      setNotice(`复制失败：${(error as Error).message}`)
    }
  }

  const openFolder = async () => {
    logAction('打开日志文件夹')
    const bridge = desktop()
    if (!bridge?.openLogFolder) {
      setNotice(info ? `日志目录：${info.log_dir}` : '浏览器中无法打开本地文件夹')
      return
    }
    const result = await bridge.openLogFolder()
    if (!result.opened) setNotice(`打开失败：${result.error || '未知原因'}`)
  }

  const exportBundle = async () => {
    setBusy('bundle')
    logAction('导出诊断包', { verbose })
    try {
      const bridge = desktop()
      if (bridge?.exportDiagnosticsBundle) {
        const result = await bridge.exportDiagnosticsBundle()
        if (result.saved) setNotice(`诊断包已保存：${result.path}`)
        else setNotice(BUNDLE_FAILURES[result.reason || ''] || `导出失败：${result.error || result.reason}`)
      } else {
        window.open(api.bundleUrl(3), '_blank')
        setNotice('诊断包下载已开始')
      }
    } finally {
      setBusy('')
    }
  }

  const switchVerbose = async (enabled: boolean) => {
    const result = await api.setVerbose(enabled)
    setVerbose(result.verbose)
    logAction('切换详细日志', { enabled: result.verbose })
  }

  return (
    <div className="diagnostics">
      <div className="diag-actions">
        <button className="btn-ghost" onClick={openFolder}>
          <FolderOpen size={15} /> 打开日志文件夹
        </button>
        <button className="btn-ghost" onClick={copyRecent}>
          复制最近日志
        </button>
        <button className="btn-ghost" disabled={busy === 'bundle'} onClick={exportBundle}>
          <Download size={15} /> {busy === 'bundle' ? '打包中…' : '导出诊断包'}
        </button>
      </div>

      <div className="setting-toggle">
        <span>
          <strong>详细日志</strong>
          <small>
            记录 DEBUG 级别与请求／响应正文摘要，便于排查难复现的问题。
            开启后日志可能含有对话内容，含敏感信息，请勿随意分享。
          </small>
        </span>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={verbose}
            onChange={(event) => void switchVerbose(event.target.checked)}
          />
          <i aria-hidden="true" />
        </label>
      </div>

      {verbose && (
        <div className="diag-warning">
          <AlertTriangle size={15} />
          详细日志已开启，此期间的日志与诊断包可能包含完整对话内容，分享前请自行确认。
        </div>
      )}

      {info && (
        <div className="diag-info">
          <span>版本 {info.app_version}</span>
          <span>{info.platform}</span>
          <span>Python {info.python}</span>
          <span>{info.log_files} 个日志文件 / {(info.log_bytes / 1024 / 1024).toFixed(1)} MB</span>
        </div>
      )}

      <div className="diag-filters">
        <div className="diag-search">
          <Search size={14} />
          <input
            value={search}
            placeholder="搜索消息、模块或 trace_id"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <button
          className={live ? 'btn-primary' : 'btn-ghost'}
          onClick={() => setLive((value) => !value)}
        >
          {live ? <Pause size={15} /> : <Play size={15} />}
          {live ? (connected ? '实时中' : '连接中…') : '实时'}
        </button>
        <button className="btn-ghost" disabled={busy === 'loading' || live} onClick={() => void reload()}>
          <RefreshCw size={15} /> 刷新
        </button>
      </div>

      <div className="diag-chips">
        {LEVELS.map((level) => (
          <button
            key={level}
            className={`diag-chip level-${level.toLowerCase()} ${levels.includes(level) ? 'on' : ''}`}
            onClick={() => toggle(levels, level, setLevels)}
          >
            {level}
          </button>
        ))}
        <span className="diag-chip-sep" />
        {SOURCES.map((item) => (
          <button
            key={item.key}
            className={`diag-chip ${sources.includes(item.key) ? 'on' : ''}`}
            onClick={() => toggle(sources, item.key, setSources)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {notice && <div className="diag-notice" onClick={() => setNotice('')}>{notice}</div>}

      <div className="diag-log" ref={listRef}>
        {visible.length === 0 && <div className="diag-empty">没有符合条件的日志</div>}
        {visible.map((record) => (
          <LogLine key={`${record.source}-${record.seq}`} record={record} />
        ))}
      </div>
    </div>
  )
}

function formatLine(record: LogRecord): string {
  const fields = Object.keys(record.fields || {}).length
    ? ` ${JSON.stringify(record.fields)}`
    : ''
  const trace = record.trace_id ? ` trace=${record.trace_id}` : ''
  return `[${record.ts}] [${record.level}] [${record.logger || record.source}] ${record.message}${trace}${fields}`
    + (record.stack ? `\n${record.stack}` : '')
}

function LogLine({ record }: { record: LogRecord }) {
  const [open, setOpen] = useState(false)
  const hasDetail = !!record.stack || Object.keys(record.fields || {}).length > 0

  return (
    <div className={`diag-line level-${record.level.toLowerCase()}`}>
      <button
        className="diag-line-head"
        onClick={() => hasDetail && setOpen((value) => !value)}
      >
        <span className="diag-ts">{record.ts.slice(11)}</span>
        <span className="diag-level">{record.level}</span>
        <span className="diag-logger">{record.logger || record.source}</span>
        <span className="diag-msg">{record.message}</span>
        {record.trace_id && <span className="diag-trace">{record.trace_id}</span>}
      </button>
      {open && (
        <pre className="diag-detail">
          {Object.keys(record.fields || {}).length
            ? JSON.stringify(record.fields, null, 2)
            : ''}
          {record.stack ? `\n${record.stack}` : ''}
        </pre>
      )}
    </div>
  )
}
