import { useEffect } from 'react'
import { useStore } from '../store'

const MAX_ATTEMPTS = 15
const RETRY_DELAY_MS = 1000

/**
 * 初始化全站数据。
 *
 * 双击 start.bat 时，前端常常比后端更早启动。这里允许前端自动等待约
 * 15 秒，避免用户刚打开页面就看到一次性的连接错误。
 */
export function useInitializeApp(): void {
  const init = useStore((state) => state.init)
  const setError = useStore((state) => state.setError)

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const tryInitialize = async (attempt: number) => {
      try {
        await init()
        if (!cancelled) setError(null)
      } catch (error) {
        if (cancelled) return
        if (attempt < MAX_ATTEMPTS) {
          setError('正在等待后端服务启动…')
          retryTimer = setTimeout(
            () => tryInitialize(attempt + 1),
            RETRY_DELAY_MS,
          )
        } else {
          setError(`初始化失败：${(error as Error).message}，请确认后端服务已启动`)
        }
      }
    }

    tryInitialize(1)
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [init, setError])
}

