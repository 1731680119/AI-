import catalog from '../../../../backend/search_capabilities.json'
import type { SearchProvider } from '../../types'

type ApiType = NonNullable<SearchProvider['api_type']>
type Strategy = NonNullable<SearchProvider['search_strategy']>

export const API_LABELS: Record<ApiType, string> = {
  auto: '自动（根据模型适配）', dashscope: 'DashScope 原生',
  chat_completions: 'OpenAI Chat Completions', responses: 'OpenAI Responses',
}
export const STRATEGY_LABELS: Record<string, string> = {
  turbo: 'turbo · 快速搜索', max: 'max · 多源深入搜索',
  agent: 'agent · 多轮自主检索', agent_max: 'agent_max · 多轮检索与网页抓取',
}

export function searchProtocol(p: SearchProvider): string {
  if (p.protocol && p.protocol in catalog.providers) return p.protocol
  const host = searchHost(p)
  for (const [kind, rule] of Object.entries(catalog.providers)) {
    if (rule.hosts.includes(host) || rule.host_suffixes.some(suffix => host.endsWith(suffix))) return kind
  }
  const probe = `${p.name} ${p.base_url}`.toLowerCase()
  return Object.entries(catalog.providers).find(([, rule]) => rule.keywords.some(word => probe.includes(word)))?.[0] || 'deepseek'
}

function searchHost(p: SearchProvider): string {
  try { return new URL(p.base_url).hostname.toLowerCase() } catch { return '' }
}

export function officialSearchUnsupported(p: SearchProvider): boolean {
  return catalog.providers.deepseek.hosts.includes(searchHost(p))
}

export function searchBasePlaceholder(p: SearchProvider): string {
  return catalog.providers[searchProtocol(p) as keyof typeof catalog.providers].base_url
}

export function structuredSearchHint(p: SearchProvider): string {
  if (searchProtocol(p) === 'kimi') {
    const pro = /\/tools\/search_pro\/?$/.test((() => { try { return new URL(p.base_url).pathname } catch { return '' } })())
    return `Kimi 使用 /v1/tools/${pro ? 'search_pro（Pro）' : 'search（Basic）'} 独立搜索接口，无需填写聊天模型。`
  }
  const international = catalog.providers.glm.international.hosts.includes(searchHost(p))
  return `${international ? 'Z.AI 国际站' : '智谱国内站'}使用 /web_search（${international ? 'search-prime' : 'search_pro'}）独立搜索接口，无需填写聊天模型。${international ? '' : '搜索词最多 70 个字符。'}Coding Plan/MCP 地址需使用对应服务，不能复用到此处。`
}

export function searchModelRule(model: string) {
  model = model.trim().toLowerCase()
  return catalog.rules.find(rule => {
    if (!new RegExp(rule.pattern).test(model)) return false
    const snapshot = model.match(/(\d{4}-\d{2}-\d{2})$/)?.[1]
    let minimum = rule.min_snapshot || ''
    for (const [name, date] of Object.entries(rule.min_snapshots || {})) {
      if (model.includes(`-${name}`)) minimum = date
    }
    return !snapshot || !minimum || snapshot >= minimum
  })
}

export function searchApiTypes(model: string): ApiType[] {
  const rule = searchModelRule(model)
  if (!rule) return []
  const types: ApiType[] = rule.strategies.length ? ['dashscope'] : []
  if (rule.responses && !rule.no_responses?.includes(model.toLowerCase())) types.push('responses')
  return types
}

export function searchApiType(p: SearchProvider): ApiType {
  const types = searchApiTypes(p.model)
  return types.includes(p.api_type || 'auto') ? p.api_type! : types[0] || 'dashscope'
}

export function searchStrategies(p: SearchProvider): Strategy[] {
  return searchApiType(p) === 'responses' ? [] : (searchModelRule(p.model)?.strategies || []) as Strategy[]
}

export function adaptSearchProvider(p: SearchProvider): SearchProvider {
  if (searchProtocol(p) !== 'qwen') return p
  const api_type = p.api_type && p.api_type !== 'auto' ? searchApiType(p) : 'auto'
  const next = { ...p, api_type }
  const choices = searchStrategies(next)
  return { ...next, search_strategy: choices.includes(p.search_strategy || '') ? p.search_strategy : choices[0] || '' }
}

export function searchEndpoint(p: SearchProvider): string {
  try {
    const url = new URL(p.base_url)
    const root = url.origin + url.pathname.replace(/\/(?:compatible-mode|api\/v1|v1)(?:\/.*)?$/, '').replace(/\/$/, '')
    const api = searchApiType(p)
    if (api === 'responses') return root + '/compatible-mode/v1/responses'
    if (api === 'chat_completions') return root + '/compatible-mode/v1/chat/completions'
    return root + `/api/v1/services/aigc/${searchModelRule(p.model)?.multimodal ? 'multimodal' : 'text'}-generation/generation`
  } catch { return '' }
}
