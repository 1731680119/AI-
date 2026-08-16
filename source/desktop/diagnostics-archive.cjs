/**
 * 崩溃诊断归档。
 *
 * 设计要点：这条路必须**不依赖后端**。软件闪退时后端多半也没起来，
 * 走 /api/diagnostics/bundle 等于什么都拿不到，所以这里直接从 logDir 拷文件。
 * 后端日志和桌面兜底日志本来就写在同一个 logDir，拷贝就够了，不必绕后端再打包一次。
 *
 * 产物是**文件夹**（不是压缩包），放在 logDir/diagnostics/ 下，命名带状态前缀：
 *   未处理-2026-08-16-153012  → 还没人看过
 *   已处理-2026-08-16-153012  → 问题已解决
 * 状态只看前缀，所以在资源管理器里手动改名同样有效。
 *
 * 清理：每次启动检查一次（同一天不重复扫），已处理超 30 天删、未处理超 90 天删。
 */
const fs = require('node:fs')
const path = require('node:path')

const DIR_NAME = 'diagnostics'
const PREFIX_PENDING = '未处理'
const PREFIX_DONE = '已处理'
/** 清理阈值（天）。未处理的留久一点，避免用户还没来得及看就被删掉。 */
const KEEP_DONE_DAYS = 30
const KEEP_PENDING_DAYS = 90
const CLEANUP_STAMP = '.last-cleanup'
/** 单个文件的拷贝上限。日志本身有 10MB 轮转，留一倍余量兜底异常膨胀的文件。 */
const MAX_FILE_BYTES = 32 * 1024 * 1024
/** 不该进归档的控制文件：它们是状态标记，没有排查价值，还会误导阅读者。 */
const SKIP_FILES = new Set(['.clean-exit', '.session'])

/** 本地时间的 YYYY-MM-DD-HHMMSS。用 UTC 会和用户看到的崩溃时间对不上。 */
function stampNow(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 从文件夹名反解时间。删除判断不看 mtime——拷贝、同步都会把 mtime 改掉。 */
function parseStamp(name) {
  const match = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name)
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match.map(Number)
  const date = new Date(y, mo - 1, d, h, mi, s)
  return Number.isFinite(date.getTime()) ? date : null
}

const archiveRoot = (logDir) => path.join(logDir, DIR_NAME)

function statusOf(name) {
  if (name.startsWith(`${PREFIX_DONE}-`)) return 'done'
  if (name.startsWith(`${PREFIX_PENDING}-`)) return 'pending'
  return 'unknown'
}

/**
 * 生成一份诊断文件夹。调用方不需要 try：这里内部吞掉所有异常，
 * 失败时返回 { created: false }，绝不能因为打包失败又把启动流程带崩。
 */
function createArchive(options) {
  const { logDir, reason = '', crashes = [], env = {}, verbose = false } = options || {}
  if (!logDir) return { created: false, error: 'logDir 未配置' }
  try {
    const root = archiveRoot(logDir)
    fs.mkdirSync(root, { recursive: true })
    const stamp = stampNow()
    let dir = path.join(root, `${PREFIX_PENDING}-${stamp}`)
    // 同一秒内重复触发（极少见）不覆盖已有目录，加个序号。
    for (let index = 2; fs.existsSync(dir); index += 1) {
      dir = path.join(root, `${PREFIX_PENDING}-${stamp}-${index}`)
    }
    fs.mkdirSync(dir, { recursive: true })

    const copied = copyLogFiles(logDir, dir)
    writeText(path.join(dir, '环境信息.txt'), environmentText(env, reason, crashes, copied))
    writeText(path.join(dir, '说明.md'), readmeText(verbose))
    return { created: true, dir, name: path.basename(dir), files: copied.length }
  } catch (error) {
    return { created: false, error: error.message }
  }
}

/** 只拷 logDir 顶层的普通文件；diagnostics/ 子目录本身当然要跳过，否则会自我嵌套。 */
function copyLogFiles(logDir, target) {
  const copied = []
  let entries = []
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true })
  } catch {
    return copied
  }
  for (const entry of entries) {
    if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue
    const from = path.join(logDir, entry.name)
    try {
      const stat = fs.statSync(from)
      if (stat.size > MAX_FILE_BYTES) continue
      fs.copyFileSync(from, path.join(target, entry.name))
      copied.push({ name: entry.name, bytes: stat.size })
    } catch {
      /* 单个文件拷不动不影响其它文件 */
    }
  }
  return copied
}

function writeText(file, text) {
  try {
    fs.writeFileSync(file, text, 'utf8')
  } catch {
    /* 忽略 */
  }
}

function environmentText(env, reason, crashes, copied) {
  const lines = [
    '# 环境信息',
    `生成时间：${new Date().toLocaleString()}`,
    `上次退出判定：${reason || '未知'}`,
    '',
    '## 应用',
    `版本：${env.appVersion ?? ''}`,
    `上次运行版本：${env.previousVersion || '（无记录）'}`,
    `安装位置：${env.execPath ?? ''}`,
    '',
    '## 运行环境',
    `Electron：${env.electron ?? ''}`,
    `Chrome：${env.chrome ?? ''}`,
    `Node：${env.node ?? ''}`,
    `系统：${env.platform ?? ''}`,
    `架构：${env.arch ?? ''}`,
    '',
    '## 崩溃记录（最近若干条）',
  ]
  if (!crashes.length) {
    lines.push('（没有结构化崩溃记录，线索请看日志文件）')
  } else {
    for (const item of crashes) {
      lines.push(`- [${item.timestamp}] ${item.kind}：${item.message}`)
      if (item.detail) lines.push(`  ${String(item.detail).split('\n').join('\n  ')}`)
    }
  }
  lines.push('', '## 打包进来的文件')
  if (!copied.length) lines.push('（没有拷到任何日志文件）')
  for (const item of copied) {
    lines.push(`- ${item.name}（${(item.bytes / 1024).toFixed(1)} KB）`)
  }
  return `${lines.join('\r\n')}\r\n`
}

function readmeText(verbose) {
  return `# 这份文件夹是什么

软件上次运行**异常退出**（没打开、闪退、启动失败等），本次启动时自动把日志打包到了这里。
目的是让你或 AI 能直接拿到排查所需的全部材料，不用再手动去翻日志目录。

## 里面有什么

| 文件 | 说明 |
| --- | --- |
| \`环境信息.txt\` | 版本、系统、Electron/Node 版本、崩溃记录摘要。**先看这个** |
| \`desktop-fallback.log\` | 主进程兜底日志。后端没起来时的记录只在这里 |
| \`backend-stdio.log\` | 后端进程的标准输出／错误，后端起不来时看它 |
| \`crashes.json\` | 结构化的崩溃记录 |
| 其它 \`*.log\` | 后端按级别／模块写的日志 |

## 未处理 / 已处理

文件夹名的前缀就是状态，程序只认前缀：

- \`未处理-日期-时间\`：问题还没解决。
- \`已处理-日期-时间\`：问题已解决，可以等它被自动清理。

改状态有两种方式，都有效：

1. 在软件里点「标记为已处理」（崩溃提示弹窗、设置 → 诊断里都有）。
2. 直接在资源管理器里把文件夹名的「未处理」三个字改成「已处理」。

> **交给 AI 排查时**：AI 修完问题后应当自己把这个文件夹前缀改成「已处理」，不需要你再提醒。

## 自动清理

每次启动软件时检查一次（同一天只扫一遍）：

- \`已处理\` 的文件夹，超过 ${KEEP_DONE_DAYS} 天自动删除。
- \`未处理\` 的文件夹，超过 ${KEEP_PENDING_DAYS} 天也会删除（防止忘了处理无限堆积）。

保留天数按文件夹名里的时间算，不看文件修改时间——拷贝、同步都会改 mtime。
想长期保留某份日志，把它挪到 \`diagnostics\` 目录外面。

## 敏感信息提示

日志在写入时已经做过脱敏：API Key 只留前 4 位，用户目录替换成 \`%USERPROFILE%\`。
但**如果这段时间开启过「详细日志」**，后端会记录请求与响应正文，
里面可能有完整的对话内容。${verbose ? '\n\n**当前「详细日志」处于开启状态，这份日志很可能含有对话正文。**' : ''}

分享给别人或上传之前，请自己扫一眼。
`
}

/** 手动/程序标记为已处理。已经是已处理就直接返回成功，调用方不用判重。 */
function markProcessed(dir) {
  try {
    const name = path.basename(dir)
    if (statusOf(name) === 'done') return { ok: true, dir, name }
    if (statusOf(name) !== 'pending') return { ok: false, error: '不是诊断文件夹' }
    const next = path.join(path.dirname(dir), name.replace(PREFIX_PENDING, PREFIX_DONE))
    fs.renameSync(dir, next)
    return { ok: true, dir: next, name: path.basename(next) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

function listArchives(logDir) {
  const root = archiveRoot(logDir)
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && statusOf(entry.name) !== 'unknown')
    .map((entry) => ({
      name: entry.name,
      dir: path.join(root, entry.name),
      status: statusOf(entry.name),
      createdAt: parseStamp(entry.name),
    }))
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
}

/**
 * 按保留策略清理。每天最多跑一次，靠 .last-cleanup 里的日期判断，
 * 不用常驻定时器——软件闪退频繁时定时器根本活不到触发。
 */
function cleanup(logDir, options = {}) {
  const root = archiveRoot(logDir)
  const stampFile = path.join(root, CLEANUP_STAMP)
  const today = stampNow().slice(0, 10)
  if (!options.force) {
    try {
      if (fs.readFileSync(stampFile, 'utf8').trim() === today) return { skipped: true, removed: [] }
    } catch {
      /* 没扫过，继续 */
    }
  }

  const now = Date.now()
  const removed = []
  for (const item of listArchives(logDir)) {
    if (!item.createdAt) continue
    const days = (now - item.createdAt.getTime()) / 86400000
    const limit = item.status === 'done' ? KEEP_DONE_DAYS : KEEP_PENDING_DAYS
    if (days <= limit) continue
    try {
      fs.rmSync(item.dir, { recursive: true, force: true })
      removed.push({ name: item.name, status: item.status, days: Math.floor(days) })
    } catch {
      /* 删不掉（比如文件被占用）就留到下次 */
    }
  }
  try {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(stampFile, today, 'utf8')
  } catch {
    /* 忽略 */
  }
  return { skipped: false, removed }
}

module.exports = {
  archiveRoot,
  createArchive,
  markProcessed,
  listArchives,
  cleanup,
  statusOf,
  _internal: { stampNow, parseStamp, KEEP_DONE_DAYS, KEEP_PENDING_DAYS },
}
