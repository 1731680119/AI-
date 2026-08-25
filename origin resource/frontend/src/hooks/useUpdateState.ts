import { useCallback, useEffect, useState } from 'react'

/** 主进程 updater.cjs 推过来的状态。字段含义见那边的注释。 */
export interface UpdateState {
  status:
    | 'idle' | 'checking' | 'available' | 'not-available'
    | 'downloading' | 'downloaded' | 'error' | 'disabled'
  currentVersion: string
  version: string
  releaseNotes: string
  releaseDate: string
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
  error: string
  checkedAt: number
  /** 本次是走哪条线路连上的：直连 / DoH 解析直连 / 镜像 xxx / 系统代理 xxx。 */
  channel: string
}

interface UpdateBridge {
  getUpdateState?: () => Promise<UpdateState>
  checkForUpdate?: () => Promise<UpdateState>
  downloadUpdate?: () => Promise<UpdateState>
  installUpdate?: () => Promise<boolean>
  onUpdateState?: (callback: (state: UpdateState) => void) => () => void
}

const bridge = () =>
  (window as unknown as { chatbotDesktop?: UpdateBridge }).chatbotDesktop

const INITIAL: UpdateState = {
  status: 'disabled',
  currentVersion: '',
  version: '',
  releaseNotes: '',
  releaseDate: '',
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  error: '',
  checkedAt: 0,
  channel: '',
}

/**
 * 订阅自动更新状态。
 *
 * 挂载时主动拉一次当前状态（主进程可能在窗口出现之前就查完了），
 * 之后靠 `desktop:update-state` 广播增量刷新。浏览器里没有这个桥，
 * 状态恒为 disabled，界面据此显示成「网页版不支持自动更新」。
 */
export function useUpdateState() {
  const [state, setState] = useState<UpdateState>(INITIAL)
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    const api = bridge()
    if (!api?.getUpdateState || !api.onUpdateState) return
    setSupported(true)
    let alive = true
    void api.getUpdateState()
      .then((value) => { if (alive) setState(value) })
      .catch(() => { /* 拉不到就先用初始值，广播来了自然会刷新 */ })
    const off = api.onUpdateState((value) => setState(value))
    return () => { alive = false; off() }
  }, [])

  const check = useCallback(async () => {
    const api = bridge()
    if (!api?.checkForUpdate) return
    setState((prev) => ({ ...prev, status: 'checking', error: '' }))
    const value = await api.checkForUpdate()
    setState(value)
  }, [])

  const download = useCallback(async () => {
    const api = bridge()
    if (!api?.downloadUpdate) return
    setState(await api.downloadUpdate())
  }, [])

  const install = useCallback(async () => {
    const api = bridge()
    if (!api?.installUpdate) return
    await api.installUpdate()
  }, [])

  /** 侧边栏小红点只认这一个条件：查到了新版，或者已经下好等着装。 */
  const hasUpdate = state.status === 'available' || state.status === 'downloading'
    || state.status === 'downloaded'

  return { state, supported, hasUpdate, check, download, install }
}
