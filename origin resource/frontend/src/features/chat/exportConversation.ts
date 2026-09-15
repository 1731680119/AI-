import type { ConversationTree, Message } from '../../types'

/**
 * 从消息树推导当前激活路径。
 * 导出与消息列表共用这一份，避免两处各写一套回溯逻辑而走岔。
 */
export function activePathOf(tree: ConversationTree | null): Message[] {
  if (!tree || !tree.messages.length) return []
  const byId = new Map(tree.messages.map((m) => [m.id, m]))
  const path: Message[] = []
  let cur = tree.active_leaf_id ? byId.get(tree.active_leaf_id) : undefined
  // 兜底：若 active_leaf 缺失取最后一条
  if (!cur) cur = tree.messages[tree.messages.length - 1]
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    path.unshift(cur)
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
  }
  return path
}

const ROLE_LABEL: Record<string, string> = {
  user: '我',
  assistant: '助手',
  system: '系统',
}

/** 文件名不能带路径分隔符和 Windows 保留字符，统一换成下划线。 */
function safeName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  return (cleaned || '对话').slice(0, 60)
}

function stamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 导出为 Markdown：只含当前分支，思考过程和附件名一并保留。 */
export function toMarkdown(tree: ConversationTree, path: Message[]): string {
  const lines: string[] = [`# ${tree.title}`, '', `> 导出时间：${stamp(new Date().toISOString())}`, '']

  for (const m of path) {
    lines.push(`## ${ROLE_LABEL[m.role] || m.role}`, '')
    if (m.created_at) lines.push(`*${stamp(m.created_at)}${m.model ? ` · ${m.model}` : ''}*`, '')

    if (m.attachments?.length) {
      lines.push(`附件：${m.attachments.map((a) => a.name).join('、')}`, '')
    }
    if (m.thinking) {
      // 思考过程折叠，正文才是读者要看的东西。
      lines.push('<details><summary>思考过程</summary>', '', '```', m.thinking, '```', '', '</details>', '')
    }
    for (const call of m.tool_calls || []) {
      const isMemory = call.tool === 'remember'
      const label = isMemory ? '记忆' : '联网搜索'
      const arg = isMemory ? call.arguments.content : call.arguments.query
      lines.push(`> ${label}：${typeof arg === 'string' ? arg : ''}`.trimEnd(), '')
    }
    lines.push(m.content || '', '')
  }

  return lines.join('\n')
}

/** 导出为 JSON：保留完整消息树（含所有分支），用于备份或再导入。 */
export function toJson(tree: ConversationTree): string {
  return JSON.stringify(tree, null, 2)
}

function download(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // 立刻 revoke 会让部分浏览器拿不到内容，等一帧再释放。
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function exportConversation(tree: ConversationTree, format: 'md' | 'json') {
  const base = safeName(tree.title)
  if (format === 'json') {
    download(`${base}.json`, toJson(tree), 'application/json')
  } else {
    download(`${base}.md`, toMarkdown(tree, activePathOf(tree)), 'text/markdown')
  }
}
