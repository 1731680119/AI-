import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useStore } from '../../../store'

/**
 * 代码执行确认框。
 *
 * 几条刻意的设计：
 *   * 代码完整展示且可编辑——用户能改完再放行，比只能二选一有用得多。
 *   * 点遮罩不关框：误触会白费一轮对话，只有明确点「拒绝」或按 Esc 才算答复。
 *   * 显示倒计时，因为后端正停在等待上，超时会按拒绝处理，用户该知道这件事。
 */
export function CodeExecConfirm() {
  const req = useStore((s) => s.codeExecRequest)
  const answer = useStore((s) => s.answerCodeExec)
  const [code, setCode] = useState('')
  const [trust, setTrust] = useState(false)
  const [left, setLeft] = useState(0)

  // 每次新请求都重置：上一次改过的代码不能泄漏到下一次。
  useEffect(() => {
    if (!req) return
    setCode(req.code)
    setTrust(false)
    setLeft(req.timeout_seconds)
  }, [req])

  useEffect(() => {
    if (!req) return
    const timer = setInterval(() => setLeft((v) => (v > 0 ? v - 1 : 0)), 1000)
    return () => clearInterval(timer)
  }, [req])

  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') answer(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [req, answer])

  if (!req) return null

  const edited = code !== req.code

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <h2>允许运行这段代码？</h2>
          <button className="icon-btn" title="拒绝" onClick={() => answer(false)}>
            <X size={17} />
          </button>
        </div>

        <div className="modal-body">
          <div className="exec-warn">
            <AlertTriangle size={15} />
            <span>
              代码会以你的用户身份在本机运行。已限制为纯计算标准库，不能读写文件、不能联网，
              但这是代码层面的限制，不是系统级沙箱。请先看清代码再放行。
            </span>
          </div>

          {req.purpose && <div className="exec-purpose">用途：{req.purpose}</div>}

          <div className="exec-meta">
            <span>
              {req.modules.length > 0
                ? `导入模块：${req.modules.join('、')}`
                : '没有导入任何模块'}
            </span>
            <span className={`exec-countdown${left <= 20 ? ' urgent' : ''}`}>
              {left > 0 ? `${left} 秒后自动拒绝` : '已超时，将按拒绝处理'}
            </span>
          </div>

          <div className="field">
            <textarea
              className="exec-code"
              value={code}
              rows={12}
              spellCheck={false}
              onChange={(e) => setCode(e.target.value)}
            />
            <div className="hint">
              可以直接改这段代码，改后的版本会重新做一遍安全检查。
              {edited && ' 已修改。'}
            </div>
          </div>

          <label className="exec-trust">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
            <span>本轮对话内不再询问（切换会话或重启后失效）</span>
          </label>
        </div>

        <div className="modal-footer">
          <button className="btn-ghost" onClick={() => answer(false)}>拒绝</button>
          <button
            className="btn-primary"
            disabled={!code.trim()}
            onClick={() => answer(true, edited ? code : undefined, trust)}
          >
            允许运行
          </button>
        </div>
      </div>
    </div>
  )
}
