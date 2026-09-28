/**
 * 启动时检查「本地仓库」和「云端仓库」是否一致，防止忘记同步就开始用。
 *
 * 为什么需要它：这个应用的用户数据（chatbot.db、desktop-settings.json、图片附件）
 * 通过一个 junction 挂进了 git 仓库的 user-data/ 目录（见 CLAUDE.md §10）。
 * 两台机器轮流用，靠的是「开工前 pull、收工后 push」。一旦忘记 pull 就开始聊天，
 * 两边的 chatbot.db 各自往前走，而 git 对二进制没有三方合并——只能二选一，
 * 另一边的聊天记录直接丢。所以这个检查的目的不是「保持整洁」，是防数据丢失。
 *
 * 几条刻意的设计：
 *
 * - **只读，绝不写。** 只跑 `rev-parse`、`fetch`、`rev-list`、`status --porcelain`。
 *   不跑 pull / merge / checkout / reset。要真动仓库就交给根目录那两个 .bat，
 *   它们自带「应用是否在运行」的检查（运行中的 SQLite 处于 WAL 状态，
 *   此时 pull 下来的 db 可能是坏的）。软件自己在后台偷偷 pull 是危险的：
 *   数据库正被自己占用着。
 *
 * - **没有 .git 就整体跳过。** 普通用户从 Release 装的包不是 git 仓库，
 *   对他们来说这个功能不存在，不弹窗、不跑 git、不写日志噪音。
 *
 * - **不阻塞启动。** fetch 要走网络，可能几秒也可能十几秒（GitHub 在国内经常很慢）。
 *   主窗口先出来，检查在后台跑，只有真的不一致才弹窗。
 *
 * - **全程禁掉交互式认证。** `GIT_TERMINAL_PROMPT=0` 加 `core.askPass=`、
 *   `credential.interactive=never`。否则没凭据时 git 会等一个永远不会来的输入，
 *   进程挂在那里不返回。fetch 失败就当「查不出来」，静默放过——
 *   网络不通不是用户的错，不该拿弹窗拦他。
 *
 * - **git 不在 PATH 也要能找到。** 应用是 GUI 进程，拿到的 PATH 和终端里的不一样。
 *   按常见安装位置逐个探（注意 Git 不一定装在 C 盘）。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const diag = require('./diagnostics-logger.cjs')

/** 单次 git 调用的上限。fetch 走网络给得宽些，本地命令很快。 */
const LOCAL_TIMEOUT_MS = 10000
const FETCH_TIMEOUT_MS = 45000

/**
 * 从这个目录往上找 `.git`，最多爬这么多层。
 * 打包后 desktop/ 在 resources/app.asar 里，仓库根在安装目录，中间隔着好几层。
 */
const MAX_WALK_UP = 8

/** git 可能的安装位置。PATH 里找不到时按顺序探，第一个存在的就用。 */
function gitCandidates() {
  const drives = ['C', 'D', 'E', 'F']
  const suffixes = [
    path.join('Program Files', 'Git', 'cmd', 'git.exe'),
    path.join('Program Files (x86)', 'Git', 'cmd', 'git.exe'),
    path.join('Program Files', 'Git', 'bin', 'git.exe'),
  ]
  const list = []
  for (const drive of drives) {
    for (const suffix of suffixes) list.push(`${drive}:\\${suffix}`)
  }
  return list
}

let cachedGitPath = null

/** 找一个能用的 git。先试 PATH（`git --version` 能跑通就算），再试常见位置。 */
function resolveGit() {
  if (cachedGitPath !== null) return cachedGitPath
  const probe = spawnSync('git', ['--version'], { timeout: LOCAL_TIMEOUT_MS, windowsHide: true })
  if (!probe.error && probe.status === 0) {
    cachedGitPath = 'git'
    return cachedGitPath
  }
  for (const candidate of gitCandidates()) {
    try {
      if (fs.existsSync(candidate)) {
        cachedGitPath = candidate
        return cachedGitPath
      }
    } catch { /* 探测失败就试下一个 */ }
  }
  cachedGitPath = ''
  return cachedGitPath
}

/**
 * 跑一条 git 命令，返回 `{ ok, out }`。
 *
 * 所有调用都带上禁用交互认证的参数——少一个都可能让进程永久挂住。
 */
function git(repoDir, args, timeoutMs = LOCAL_TIMEOUT_MS) {
  const exe = resolveGit()
  if (!exe) return { ok: false, out: '', reason: 'git-not-found' }
  // 只禁「交互式」提问，不禁凭据存储本身。
  // 这台机器的 git 认证靠 Windows 凭据管理器（credential.helper=manager），
  // 把 credential.helper 清空会连带把它关掉，fetch 直接 'unable to get password from user'。
  // GIT_TERMINAL_PROMPT=0 + credential.interactive=never 已经够了：
  // 有存好的凭据就用，没有就立刻失败，不会挂在那里等一个永远不来的输入。
  const result = spawnSync(exe, [
    '-c', 'credential.interactive=never',
    ...args,
  ], {
    cwd: repoDir,
    timeout: timeoutMs,
    windowsHide: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      // GUI 进程里 askPass 相关变量若被继承下来，可能弹出图形密码框把启动卡住。
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
    },
  })
  if (result.error) {
    return { ok: false, out: '', reason: result.error.message }
  }
  if (result.status !== 0) {
    return { ok: false, out: String(result.stdout || '').trim(), reason: String(result.stderr || '').trim() }
  }
  return { ok: true, out: String(result.stdout || '').trim() }
}

/** 从 startDir 往上找包含 `.git` 的目录。找不到返回空字符串。 */
function findRepoRoot(startDir) {
  let dir = startDir
  for (let i = 0; i < MAX_WALK_UP; i += 1) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir
    } catch { /* 权限问题就继续往上 */ }
    const parent = path.dirname(dir)
    if (!parent || parent === dir) break
    dir = parent
  }
  return ''
}

/**
 * 检查一个仓库和它的上游是否一致。
 *
 * 返回 `{ status, ... }`，`status` 取值：
 * - `skipped`   不是 git 仓库 / 没有上游 / 找不到 git / fetch 失败。**一律静默放过。**
 * - `in-sync`   本地和云端一字不差，且 user-data 干净。
 * - `behind`    云端有本地没有的提交 —— 忘记拉，这是最危险的那种。
 * - `ahead`     本地有云端没有的提交 —— 忘记推。
 * - `diverged`  两边各有对方没有的提交 —— 已经分叉了。
 * - `dirty`     本地和云端提交一致，但 user-data 里有没提交的改动。
 *
 * `behind`/`ahead`/`diverged` 会同时带上 `dirtyFiles`，因为分叉时未提交的改动
 * 直接决定了处理难度，弹窗里要一起说清。
 */
function inspect(repoDir) {
  if (!repoDir) return { status: 'skipped', reason: 'no-repo' }
  if (!resolveGit()) return { status: 'skipped', reason: 'git-not-found' }

  // 确认真的在工作区里（.git 存在也可能是个坏仓库）。
  const inWorkTree = git(repoDir, ['rev-parse', '--is-inside-work-tree'])
  if (!inWorkTree.ok || inWorkTree.out !== 'true') {
    return { status: 'skipped', reason: 'not-a-work-tree' }
  }

  const branch = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = branch.ok ? branch.out : ''

  // 没有上游就没有「云端」可比，不是错误，只是这个仓库没配远端跟踪。
  const upstream = git(repoDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (!upstream.ok || !upstream.out) return { status: 'skipped', reason: 'no-upstream' }
  const upstreamRef = upstream.out
  const remote = upstreamRef.includes('/') ? upstreamRef.split('/')[0] : 'origin'

  // 读一次远端。这是唯一走网络的一步，也是唯一可能慢的一步。
  // --no-tags 少传点东西；fetch 只更新 remote-tracking ref，不动工作区。
  const fetched = git(repoDir, ['fetch', '--no-tags', '--quiet', remote], FETCH_TIMEOUT_MS)
  if (!fetched.ok) {
    // 断网、GitHub 抽风、没凭据都会走到这。查不出来就别拦用户。
    diag.info('repo-sync', '读取远端失败，跳过同步检查', { reason: fetched.reason || 'unknown' })
    return { status: 'skipped', reason: 'fetch-failed', detail: fetched.reason || '' }
  }

  // 一次拿到两个方向的差异数：输出是 "<落后数>\t<领先数>"。
  const counts = git(repoDir, ['rev-list', '--left-right', '--count', `${upstreamRef}...HEAD`])
  if (!counts.ok) return { status: 'skipped', reason: 'rev-list-failed' }
  const [behindRaw, aheadRaw] = counts.out.split(/\s+/)
  const behind = Number.parseInt(behindRaw, 10) || 0
  const ahead = Number.parseInt(aheadRaw, 10) || 0

  // 只看 user-data：源码有没有改动不影响聊天记录安全，不值得拿弹窗打扰。
  const dirty = git(repoDir, ['status', '--porcelain', '--', 'user-data'])
  const dirtyFiles = dirty.ok
    ? dirty.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length
    : 0

  const base = { repoDir, branch: branchName, upstream: upstreamRef, remote, behind, ahead, dirtyFiles }

  if (behind > 0 && ahead > 0) return { ...base, status: 'diverged' }
  if (behind > 0) return { ...base, status: 'behind' }
  if (ahead > 0) return { ...base, status: 'ahead' }
  if (dirtyFiles > 0) return { ...base, status: 'dirty' }
  return { ...base, status: 'in-sync' }
}

/** 这个状态该不该打断用户。`skipped` 和 `in-sync` 都不该。 */
function needsAttention(result) {
  return ['behind', 'ahead', 'diverged', 'dirty'].includes(result?.status)
}

/**
 * 弹窗要显示的文案。标题短，正文说清「是什么状态、为什么危险、该怎么办」。
 */
function describe(result) {
  const { behind = 0, ahead = 0, dirtyFiles = 0, branch, upstream } = result
  const where = `分支 ${branch || '?'} ↔ ${upstream || '?'}`
  const dirtyLine = dirtyFiles > 0
    ? `\n另外 user-data 里有 ${dirtyFiles} 处未提交的改动（聊天记录、设置或附件）。`
    : ''

  if (result.status === 'behind') {
    return {
      title: '云端有更新还没拉下来',
      message: `云端比本机多 ${behind} 个提交`,
      detail: `${where}\n\n另一台机器上的聊天记录、API 设置还没同步到这台。`
        + `\n现在就开始用的话，两边的数据库会各自往前走，`
        + `而聊天记录是二进制文件、没法自动合并——到时候只能二选一，另一边的记录会丢。`
        + `${dirtyLine}\n\n建议先同步再使用。`,
    }
  }
  if (result.status === 'ahead') {
    return {
      title: '本机有改动还没推上去',
      message: `本机比云端多 ${ahead} 个提交`,
      detail: `${where}\n\n这台机器上的改动还没推到云端，另一台拉不到。`
        + `\n继续用没有风险，但记得收工前推一次，否则换台机器就看不到这些记录。`
        + `${dirtyLine}`,
    }
  }
  if (result.status === 'diverged') {
    return {
      title: '本机和云端已经分叉',
      message: `本机多 ${ahead} 个提交，云端多 ${behind} 个`,
      detail: `${where}\n\n两边都有对方没有的提交，说明两台机器都改过同一份数据。`
        + `\n聊天记录是二进制文件，git 没法三方合并，只能保留一边、丢掉另一边。`
        + `${dirtyLine}\n\n建议先处理分叉再使用，别让差距继续扩大。`,
    }
  }
  return {
    title: 'user-data 有未提交的改动',
    message: `user-data 里有 ${dirtyFiles} 处未提交的改动`,
    detail: `${where}\n\n提交记录和云端一致，但本机的聊天记录、设置或附件还没提交。`
      + `\n继续用没有风险，记得收工前推一次。`,
  }
}

/**
 * 该给这个状态开哪个同步脚本。
 *
 * 落后要拉；领先要推；分叉和「只是脏」都先走拉取脚本——
 * 它会在动手前检查应用是否还在运行，并在冲突时打印二选一的处理办法。
 */
function scriptFor(result) {
  return result.status === 'ahead' ? '同步-推送.bat' : '同步-拉取.bat'
}

module.exports = {
  findRepoRoot,
  resolveGit,
  git,
  inspect,
  needsAttention,
  describe,
  scriptFor,
  LOCAL_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
}
