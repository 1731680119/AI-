import type { ConversationTree } from '../../types'
import { activePathOf } from '../chat/exportConversation'

/** 可作为 Artifact 预览的语言 */
export const ARTIFACT_LANGS = new Set(['html', 'svg'])

/** Artifact 的一个版本：对应某条回答里的某个代码块。 */
export interface ArtifactVersion {
  /** 「消息 id#同语言块序号」，切换版本时用它定位，重开会话后依然稳定。 */
  versionId: string
  messageId: string
  language: string
  code: string
  created_at: string
}

export function artifactTitle(language: string): string {
  if (language === 'svg') return 'SVG 图形'
  if (language === 'html') return 'HTML 页面'
  return language.toUpperCase() || '代码'
}

/**
 * 扫出正文里的围栏代码块。
 * 按行扫而不用正则，是因为流式输出时最后一个围栏往往还没闭合，
 * 未闭合的那段也要算一个块，否则预览要等模型写完才出现。
 */
export function extractBlocks(content: string): { language: string; code: string }[] {
  const out: { language: string; code: string }[] = []
  let lang: string | null = null
  let buf: string[] = []
  for (const line of content.split('\n')) {
    const fence = /^\s*```(.*)$/.exec(line)
    if (fence) {
      if (lang === null) {
        lang = fence[1].trim().toLowerCase()
        buf = []
      } else {
        out.push({ language: lang, code: buf.join('\n') })
        lang = null
      }
      continue
    }
    if (lang !== null) buf.push(line)
  }
  if (lang !== null && buf.length) out.push({ language: lang, code: buf.join('\n') })
  return out
}

/** 一条消息里某个代码块的版本号：同语言的块从 0 开始数。 */
export function versionIdOf(messageId: string, content: string, language: string, code: string): string {
  const same = extractBlocks(content).filter((b) => b.language === language)
  const index = same.findIndex((b) => b.code === code)
  return `${messageId}#${index < 0 ? 0 : index}`
}

/**
 * 收集当前分支上同一语言的全部 Artifact，按时间先后就是版本历史。
 * 语言相同即视为同一份东西的迭代：模型改稿时几乎都是这个形态，
 * 而正文里没有稳定的 artifact 标识可用。
 */
export function collectVersions(tree: ConversationTree | null, language: string): ArtifactVersion[] {
  const out: ArtifactVersion[] = []
  for (const m of activePathOf(tree)) {
    if (m.role !== 'assistant' || !m.content) continue
    let index = 0
    for (const block of extractBlocks(m.content)) {
      if (block.language !== language) continue
      out.push({
        versionId: `${m.id}#${index}`,
        messageId: m.id,
        language,
        code: block.code,
        created_at: m.created_at,
      })
      index++
    }
  }
  return out
}
