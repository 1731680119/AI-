import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logError, flush } from '../../services/diagnostics'

type Props = { children: ReactNode }
type State = { error: Error | null }

/**
 * 兜住渲染期异常。
 *
 * React 的渲染错误不会冒泡到 window.onerror，没有这层的话界面会直接白屏，
 * 日志里也只剩一句无头无尾的报错。这里把组件栈一起记下来，并给用户留一个
 * 可操作的出口，而不是一片空白。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logError(
      'react',
      `界面渲染异常：${error.message}`,
      { componentStack: info.componentStack ?? '' },
      error.stack,
    )
    void flush()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash-screen" role="alert">
        <h2>界面出错了</h2>
        <p>已经把这次错误写进诊断日志，可以在设置里导出诊断包。</p>
        <pre className="crash-detail">{error.message}</pre>
        <div className="crash-actions">
          <button className="btn-primary" onClick={() => window.location.reload()}>
            重新加载
          </button>
          <button className="btn-ghost" onClick={() => this.setState({ error: null })}>
            尝试恢复
          </button>
        </div>
      </div>
    )
  }
}
