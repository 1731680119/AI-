import { useEffect, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw, RotateCw,
} from 'lucide-react'
import { useUpdateState } from '../../../hooks/useUpdateState'

/** 桌面端诊断信息里带着 Electron / Chrome 版本，这一栏顺带展示。 */
interface SystemInfo {
  appVersion?: string
  electron?: string
  chrome?: string
  node?: string
  platform?: string
  arch?: string
}

const desktop = () => (window as unknown as {
  chatbotDesktop?: { diagnosticsInfo?: () => Promise<SystemInfo> }
}).chatbotDesktop

function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB'
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond) return ''
  return `${(bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`
}

/**
 * 「关于与更新」面板。
 *
 * 检查是主进程在启动后静默做的，这里只负责把结果显示出来，并提供
 * 手动检查 / 下载 / 安装三个动作。安装会退出应用并弹出 NSIS 安装向导——
 * 打包用的是非一键安装器，静默安装会丢掉用户自定义的安装目录，所以不做。
 */
export function UpdatePanel() {
  const { state, supported, check, download, install } = useUpdateState()
  const [info, setInfo] = useState<SystemInfo | null>(null)

  useEffect(() => {
    const bridge = desktop()
    if (!bridge?.diagnosticsInfo) return
    let alive = true
    void bridge.diagnosticsInfo()
      .then((value) => { if (alive) setInfo(value) })
      .catch(() => { /* 拿不到就只显示版本号 */ })
    return () => { alive = false }
  }, [])

  const version = state.currentVersion || info?.appVersion || '未知'
  const busy = state.status === 'checking' || state.status === 'downloading'

  return (
    <div className="update-panel">
      <div className="update-version">
        <span className="update-version-label">当前版本</span>
        <strong className="update-version-value">v{version}</strong>
      </div>

      {info && (
        <p className="update-env">
          Electron {info.electron} · Chrome {info.chrome} · Node {info.node} · {info.arch}
        </p>
      )}

      {!supported && (
        <p className="update-hint">
          当前是网页版，自动更新只在 Windows 桌面版里可用。
        </p>
      )}

      {supported && state.status === 'disabled' && (
        <p className="update-hint">{state.error || '当前环境不检查更新。'}</p>
      )}

      {supported && state.status !== 'disabled' && (
        <>
          <div className="update-status">
            {state.status === 'checking' && (
              <><Loader2 size={15} className="spin" /><span>正在检查更新…</span></>
            )}
            {state.status === 'not-available' && (
              <><CheckCircle2 size={15} className="ok" /><span>已经是最新版本</span></>
            )}
            {state.status === 'available' && (
              <><Download size={15} className="accent" /><span>发现新版本 v{state.version}</span></>
            )}
            {state.status === 'downloading' && (
              <>
                <Loader2 size={15} className="spin" />
                <span>
                  正在下载 v{state.version}：{state.percent}%
                  （{formatBytes(state.transferred)} / {formatBytes(state.total)}
                  {formatSpeed(state.bytesPerSecond) && ` · ${formatSpeed(state.bytesPerSecond)}`}）
                </span>
              </>
            )}
            {state.status === 'downloaded' && (
              <><CheckCircle2 size={15} className="ok" /><span>v{state.version} 已下载完成</span></>
            )}
            {state.status === 'error' && (
              <><AlertTriangle size={15} className="warn" /><span>{state.error}</span></>
            )}
            {state.status === 'idle' && <span>还没有检查过更新</span>}
          </div>

          {state.status === 'downloading' && (
            <div className="update-progress">
              <div className="update-progress-bar" style={{ width: `${state.percent}%` }} />
            </div>
          )}

          {state.releaseNotes && (state.status === 'available' || state.status === 'downloaded'
            || state.status === 'downloading') && (
            <div className="update-notes">
              <div className="update-notes-title">更新说明</div>
              {/* GitHub 的 Release 正文是 Markdown，这里按纯文本展示，
                  不引 Markdown 渲染器——它是网络内容，直接当 HTML 插会有 XSS 风险。 */}
              <pre>{state.releaseNotes}</pre>
            </div>
          )}

          {state.channel && (state.status === 'available' || state.status === 'downloading'
            || state.status === 'downloaded') && (
            <p className="update-hint">连接方式：{state.channel}</p>
          )}

          <div className="update-actions">
            <button className="btn btn-ghost" disabled={busy} onClick={() => void check()}>
              <RefreshCw size={14} />
              检查更新
            </button>
            {state.status === 'available' && (
              <button className="btn btn-primary" onClick={() => void download()}>
                <Download size={14} />
                下载新版本
              </button>
            )}
            {state.status === 'downloaded' && (
              <button className="btn btn-primary" onClick={() => void install()}>
                <RotateCw size={14} />
                退出并安装
              </button>
            )}
          </div>

          {state.status === 'downloaded' && (
            <p className="update-hint">
              点「退出并安装」后应用会关闭，接着弹出安装向导，一路点「下一步 → 安装」即可，
              聊天记录和设置不会丢失。
            </p>
          )}
          <p className="update-hint">
            只在启动时自动检查一次，之后要查请点上面的「检查更新」。有新版时侧边栏的「设置」上会出现一个红点。
            连不上 GitHub 会自动尝试换个线路（DoH 解析、镜像站、代理），只作用于更新请求本身，不改动系统网络设置。
          </p>
        </>
      )}
    </div>
  )
}
