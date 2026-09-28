/**
 * `source/desktop/repo-sync-check.cjs` 的回归测试（1.2.24 新增）。
 *
 * 跑法：node --test tools/repo-sync-check.test.mjs
 *
 * 全程用临时目录里的**本地裸仓库**当「云端」，所以：
 * - 不碰网络、不碰 GitHub、不需要任何凭据；
 * - 不碰真实仓库，更不碰 user-data/（那是用户的聊天记录）。
 *
 * 被测模块 require 了 electron 和 diagnostics-logger，这两个只能在 Electron 里跑，
 * 所以用 Module._load 打桩挡掉。
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const modulePath = path.resolve(here, '..', '..', 'source', 'desktop', 'repo-sync-check.cjs')

// electron / diagnostics-logger 打桩：被测模块只用到 diag.info 和 diag.warn。
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir() } }
  if (request.includes('diagnostics-logger')) return { info: () => {}, warn: () => {}, error: () => {} }
  return originalLoad.call(this, request, parent, isMain)
}
const repoSync = require(modulePath)
Module._load = originalLoad

let tmp = ''
let bare = ''

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr}`)
  return String(r.stdout || '').trim()
}

const commit = (dir, file, body) => {
  fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), body)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', `add ${file}`)
}

/** 从裸仓库克隆一份，配好身份，返回路径。 */
const clone = (name) => {
  const dir = path.join(tmp, name)
  git(tmp, 'clone', '-q', bare, dir)
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'test')
  return dir
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sync-test-'))
  bare = path.join(tmp, 'cloud.git')
  git(tmp, 'init', '-q', '--bare', '--initial-branch=main', bare)

  const seed = path.join(tmp, 'seed')
  fs.mkdirSync(seed)
  git(seed, 'init', '-q', '--initial-branch=main')
  git(seed, 'config', 'user.email', 'test@example.invalid')
  git(seed, 'config', 'user.name', 'test')
  commit(seed, 'user-data/notes.txt', 'base\n')
  git(seed, 'remote', 'add', 'origin', bare)
  git(seed, 'push', '-q', '-u', 'origin', 'main')
})

after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('本地与云端一致时判定 in-sync，不打扰用户', () => {
  const r = repoSync.inspect(clone('case-insync'))
  assert.equal(r.status, 'in-sync')
  assert.equal(repoSync.needsAttention(r), false)
})

test('本地有未推送的提交时判定 ahead，指向推送脚本', () => {
  const dir = clone('case-ahead')
  commit(dir, 'user-data/local.txt', 'local\n')
  const r = repoSync.inspect(dir)
  assert.equal(r.status, 'ahead')
  assert.equal(r.ahead, 1)
  assert.equal(repoSync.needsAttention(r), true)
  assert.equal(repoSync.scriptFor(r), '同步-推送.bat')
})

test('云端有未拉取的提交时判定 behind，指向拉取脚本', () => {
  // 先让云端往前走一步。
  const pusher = clone('case-pusher')
  commit(pusher, 'user-data/remote.txt', 'remote\n')
  git(pusher, 'push', '-q')

  const dir = clone('case-behind')
  git(dir, 'reset', '-q', '--hard', 'HEAD~1')
  const r = repoSync.inspect(dir)
  assert.equal(r.status, 'behind')
  assert.equal(r.behind, 1)
  assert.equal(repoSync.scriptFor(r), '同步-拉取.bat')
  // 这是最危险的那种，文案要点明记录会丢。
  assert.match(repoSync.describe(r).detail, /二选一|会丢/)
})

test('两边各有对方没有的提交时判定 diverged', () => {
  const dir = clone('case-diverged')
  git(dir, 'reset', '-q', '--hard', 'HEAD~1')
  commit(dir, 'user-data/mine.txt', 'mine\n')
  const r = repoSync.inspect(dir)
  assert.equal(r.status, 'diverged')
  assert.ok(r.ahead > 0 && r.behind > 0)
  assert.equal(repoSync.scriptFor(r), '同步-拉取.bat')
})

test('提交一致但 user-data 有改动时判定 dirty', () => {
  const dir = clone('case-dirty')
  fs.writeFileSync(path.join(dir, 'user-data', 'notes.txt'), 'changed\n')
  const r = repoSync.inspect(dir)
  assert.equal(r.status, 'dirty')
  assert.equal(r.dirtyFiles, 1)
})

test('只改源码不报警：只有 user-data 的改动威胁聊天记录', () => {
  const dir = clone('case-src-only')
  fs.writeFileSync(path.join(dir, 'readme.md'), 'source change\n')
  const r = repoSync.inspect(dir)
  assert.equal(r.status, 'in-sync')
  assert.equal(repoSync.needsAttention(r), false)
})

test('没有配上游的仓库直接跳过', () => {
  const dir = path.join(tmp, 'case-no-upstream')
  fs.mkdirSync(dir)
  git(dir, 'init', '-q', '--initial-branch=main')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'test')
  commit(dir, 'user-data/x.txt', 'x\n')
  const r = repoSync.inspect(dir)
  assert.equal(r.status, 'skipped')
  assert.equal(r.reason, 'no-upstream')
})

test('不是 git 仓库时 findRepoRoot 返回空——普通用户走这条路，整个功能不存在', () => {
  const plain = path.join(tmp, 'case-not-a-repo')
  fs.mkdirSync(plain)
  assert.equal(repoSync.findRepoRoot(plain), '')
  assert.equal(repoSync.inspect('').status, 'skipped')
})

test('findRepoRoot 能从子目录往上找到仓库根', () => {
  const dir = clone('case-walkup')
  const deep = path.join(dir, 'a', 'b', 'c')
  fs.mkdirSync(deep, { recursive: true })
  assert.equal(fs.realpathSync(repoSync.findRepoRoot(deep)), fs.realpathSync(dir))
})

test('四种需要关注的状态都有可读文案，且都能选出脚本', () => {
  for (const status of ['behind', 'ahead', 'diverged', 'dirty']) {
    const fake = { status, behind: 1, ahead: 1, dirtyFiles: 1, branch: 'main', upstream: 'origin/main' }
    const text = repoSync.describe(fake)
    assert.ok(text.title.length > 0, `${status} 缺标题`)
    assert.ok(text.message.length > 0, `${status} 缺主文`)
    assert.ok(text.detail.length > 0, `${status} 缺详情`)
    assert.match(repoSync.scriptFor(fake), /同步-(拉取|推送)\.bat/)
  }
})
