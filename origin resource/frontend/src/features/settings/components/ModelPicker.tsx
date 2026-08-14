import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2, Loader2, RefreshCw, Search, X, XCircle,
} from 'lucide-react'
import { listRemoteModels, testRemoteModel } from '../../../services/api'
import type { ModelTestResult } from '../../../types'

/**
 * 一个可以问它要模型清单的上游。
 *
 * 密钥用回调而不是直接给：桌面端「多 API」里的密钥加密存在主进程，
 * 只有用户真的点了检测才去解密取出来，不必在打开设置时就全部解一遍。
 */
export interface ModelSource {
  id: string
  name: string
  baseUrl: string
  resolveKey: () => Promise<string>
}

interface Props {
  /** 可选的上游。多于一个时（桌面端配了多套 API）头部会出现来源下拉。 */
  sources: ModelSource[]
  /** 当前已经在用的模型，打开时默认勾上。 */
  selected: string[]
  /** 多选用于「模型列表」，单选用于搜索模型、图片模型这种只有一个值的地方。 */
  multi?: boolean
  /** 是否显示逐个「测试」按钮。只有走 /chat/completions 的模型测得了。 */
  allowTest?: boolean
  /** 多选时给出勾选后的完整列表；单选时给出只含一项的数组。 */
  onConfirm: (models: string[]) => void
  onClose: () => void
}

/**
 * 模型选择器：从上游的 /models 清单里挑，而不是手打模型名。
 *
 * 分两层判断「能用」：清单是上游对外宣称的，右侧的「测试」才是真发一次
 * 请求验证调得动——中转站上架了却没有渠道、或者已经下架的情况很常见。
 */
export function ModelPicker({
  sources, selected, multi, allowTest, onConfirm, onClose,
}: Props) {
  const [sourceId, setSourceId] = useState(sources[0]?.id || '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [endpoint, setEndpoint] = useState('')
  const [keyword, setKeyword] = useState('')
  const [checked, setChecked] = useState<string[]>(selected)
  // 逐个测试的结果与正在测试的模型名。
  const [testing, setTesting] = useState('')
  const [tested, setTested] = useState<Record<string, ModelTestResult>>({})

  const source = sources.find((s) => s.id === sourceId) || sources[0]

  const load = async () => {
    if (!source) return
    setLoading(true)
    setError('')
    setModels([])
    setTested({})
    try {
      const apiKey = await source.resolveKey()
      const result = await listRemoteModels(source.baseUrl, apiKey)
      setModels(result.models || [])
      setEndpoint(result.endpoint || '')
      if (!result.ok) setError(result.message)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // 换来源就重新拉一次清单。地址或密钥改了要重新打开这个面板。
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId])

  const shown = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return models
    return models.filter((m) => m.toLowerCase().includes(kw))
  }, [models, keyword])

  const toggle = (name: string) => {
    if (!multi) {
      onConfirm([name])
      onClose()
      return
    }
    setChecked((prev) =>
      prev.includes(name) ? prev.filter((m) => m !== name) : [...prev, name])
  }

  const runTest = async (name: string) => {
    if (!source) return
    setTesting(name)
    try {
      const apiKey = await source.resolveKey()
      const result = await testRemoteModel(source.baseUrl, apiKey, name)
      setTested((prev) => ({ ...prev, [name]: result }))
    } catch (e) {
      setTested((prev) => ({
        ...prev,
        [name]: {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
          elapsed_ms: 0,
          reply: '',
        },
      }))
    } finally {
      setTesting('')
    }
  }

  return (
    <div className="model-picker">
      {sources.length > 1 && (
        <div className="model-picker-source">
          <span>来源</span>
          <select value={source?.id} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}（{s.baseUrl}）</option>
            ))}
          </select>
        </div>
      )}

      <div className="model-picker-head">
        <Search size={13} />
        <input
          autoFocus
          value={keyword}
          placeholder="筛选模型名"
          onChange={(e) => setKeyword(e.target.value)}
        />
        <button className="icon-btn" title="重新检测" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
        </button>
        <button className="icon-btn" title="关闭" onClick={onClose}><X size={13} /></button>
      </div>

      {loading && (
        <div className="model-picker-msg"><Loader2 size={13} className="spin" /> 正在读取模型清单…</div>
      )}
      {!loading && error && (
        <div className="model-picker-msg error"><XCircle size={13} /> {error}</div>
      )}

      {!loading && !error && (
        <>
          <div className="model-picker-list">
            {shown.map((name) => {
              const result = tested[name]
              return (
                <div className="model-picker-row" key={name}>
                  <label>
                    <input
                      type={multi ? 'checkbox' : 'radio'}
                      name="model-picker"
                      checked={multi ? checked.includes(name) : selected.includes(name)}
                      onChange={() => toggle(name)}
                    />
                    <span>{name}</span>
                  </label>
                  {result && (
                    <span
                      className={`model-picker-verdict ${result.ok ? 'ok' : 'bad'}`}
                      title={result.message + (result.reply ? `\n回复：${result.reply}` : '')}
                    >
                      {result.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                      {result.ok ? `${(result.elapsed_ms / 1000).toFixed(1)}s` : '不可用'}
                    </span>
                  )}
                  {allowTest && (
                    <button
                      className="btn-ghost model-picker-test"
                      disabled={Boolean(testing)}
                      title="发一次极短的请求，确认这个模型真的调得动"
                      onClick={() => void runTest(name)}
                    >
                      {testing === name ? <Loader2 size={12} className="spin" /> : '测试'}
                    </button>
                  )}
                </div>
              )
            })}
            {!shown.length && <div className="model-picker-msg">没有匹配的模型</div>}
          </div>

          <div className="model-picker-foot">
            <span className="hint">
              共 {models.length} 个{keyword.trim() ? `，匹配 ${shown.length} 个` : ''}
              {endpoint ? ` · ${endpoint}` : ''}
            </span>
            {multi && (
              <button
                className="btn-primary"
                disabled={!checked.length}
                title={checked.length ? '' : '至少留一个模型'}
                onClick={() => { onConfirm(checked); onClose() }}
              >
                用选中的 {checked.length} 个
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
