import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import { ErrorBoundary } from './components/layout/ErrorBoundary'
import { installDiagnostics } from './services/diagnostics'
import './styles/index.css'

// 尽早安装，才能捕获到首屏渲染期间的异常。
installDiagnostics()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
