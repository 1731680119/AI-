import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import { ErrorBoundary } from './components/layout/ErrorBoundary'
import { installDiagnostics } from './services/diagnostics'
import './styles/index.css'

// 尽早安装，才能捕获到首屏渲染期间的异常。
installDiagnostics()

// 文件拖到投放区以外的地方时，浏览器/Electron 默认会把窗口导航到那个文件，
// 整个应用就白屏了。这里全局兜底。投放区自己的 React 事件先于冒泡到 window 的
// 这一层执行，文件早已被接走，重复 preventDefault 无副作用（见 hooks/useFileDrop.ts）。
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => event.preventDefault())
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
