import type {
  ModelListResult, ModelTestResult, SearchProvider, SearchTestResult, Settings,
} from '../../types'
import { requestJson } from './http'

export function fetchSettings(): Promise<Settings> {
  return requestJson('/settings')
}

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return requestJson('/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/**
 * 用一套搜索配置真跑一次检索来检测可用性。
 *
 * 传的是配置本身而不是 id，所以在设置页改完、还没点保存时就能测。
 */
export function testSearchProvider(provider: SearchProvider): Promise<SearchTestResult> {
  return requestJson('/settings/search-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: provider.name,
      base_url: provider.base_url,
      api_key: provider.api_key,
      model: provider.model,
      max_output_tokens: provider.max_output_tokens,
    }),
  })
}

/**
 * 问上游要一份模型清单。只读清单，不发对话请求，所以不产生费用。
 *
 * 和检测搜索配置一样传字段而不是读设置：聊天、图片、搜索三处各有各的
 * 地址和密钥，而且常常是刚粘上地址、还没保存就想看有哪些模型能用。
 */
export function listRemoteModels(baseUrl: string, apiKey: string): Promise<ModelListResult> {
  return requestJson('/settings/model-list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
  })
}

/** 对单个模型真发一次极短的对话请求，确认它调得动（清单里有不等于能用）。 */
export function testRemoteModel(
  baseUrl: string, apiKey: string, model: string,
): Promise<ModelTestResult> {
  return requestJson('/settings/model-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, model }),
  })
}

