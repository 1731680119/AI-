/** 有交互写入的测试只允许使用 smoke_packaged.py 创建的隔离目录。 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { connect } from './cdp.mjs'
import { SCENES } from './scenes.mjs'

const source = fileURLToPath(new URL('../../../source/', import.meta.url))
const qa = path.join(source, 'release/qa-1.2.24')
const local = path.join(qa, 'final-local')
const resultFile = path.join(local, 'AI Chatbot/smoke-result.json')
const seed = JSON.parse(await fs.readFile(resultFile, 'utf8'))
assert.equal(seed.root_branch, 'passed')
assert.equal(path.resolve(seed.data), path.join(local, 'AI Chatbot/data'))
const harness = path.join(qa, 'harness')
await fs.mkdir(harness, { recursive: true })
await fs.writeFile(path.join(harness, 'package.json'), JSON.stringify({ name: 'chatbot-isolated-qa', version: '1.2.24', main: 'main.cjs' }))
await fs.writeFile(path.join(harness, 'main.cjs'), `
const { app } = require('electron');
app.setPath('sessionData', ${JSON.stringify(path.join(qa, 'session'))});
app.setUserTasks = () => {};
require(${JSON.stringify(path.join(source, 'desktop/main.cjs'))});
`)
await fs.writeFile(path.join(local, 'AI Chatbot/data/desktop-settings.json'), JSON.stringify({
  closePreference: 'close', enhancements: { apiList: [], legacyApiMigrated: true },
}))
const env = { ...process.env, LOCALAPPDATA: local }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(path.join(source, 'node_modules/electron/dist/electron.exe'),
  [harness, '--remote-debugging-port=9334'], { env, windowsHide: true, stdio: 'ignore' })
let cdp
const checks = []
try {
  // 等主页面，跳过 Electron 的启动画面 target。
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:9334/json/list')).json()
      if (list.some((t) => /^http:\/\/127\.0\.0\.1:/.test(t.url))) break
    } catch {}
    if (child.exitCode !== null) throw new Error('Electron exited before loading')
    await new Promise((r) => setTimeout(r, 500))
  }
  cdp = await connect({ port: 9334, waitMs: 10000 })
  await cdp.waitFor('.composer textarea', { timeout: 15000 })
  await cdp.settle()
  await cdp.type('.composer textarea', 'QA draft retained')
  await cdp.clickByText('.mode-switch button', '图片')
  await cdp.settle()
  await cdp.clickByText('.mode-switch button', '对话')
  await cdp.settle()
  assert.equal(await cdp.eval('document.querySelector(".composer textarea").value'), 'QA draft retained')
  checks.push('草稿切换图片页后保留')

  await cdp.click('.conv-list .conv-item')
  await cdp.settle()
  assert.equal(await cdp.eval('document.querySelector(".composer textarea").value'), '')
  await cdp.click('.new-chat-btn')
  await cdp.settle()
  assert.equal(await cdp.eval('document.querySelector(".composer textarea").value'), 'QA draft retained')
  checks.push('会话草稿相互独立')

  await cdp.eval('document.querySelector(".composer textarea").focus()')
  await cdp.key('Enter')
  await cdp.waitFor('.error-banner')
  await cdp.settle()
  assert.equal(await cdp.eval('document.querySelector(".composer textarea").value'), 'QA draft retained')
  checks.push('未配置渠道时发送失败保留草稿')
  await cdp.waitFor('.enh-failure-overlay')
  await cdp.clickByText('.enh-failure-actions button', '关闭')
  await cdp.waitFor('.enh-failure-overlay', { gone: true })

  await cdp.clickByText('.sidebar-footer button', '设置')
  await cdp.waitFor('.modal-settings')
  await cdp.waitFor('.enh-settings-section')
  await cdp.settle()
  await cdp.eval(`window.__qaFetch = window.fetch;
    window.fetch = (url, init) => String(url).endsWith('/api/settings') && init?.method === 'PUT'
      ? Promise.resolve(new Response(JSON.stringify({detail:'QA simulated save failure'}), {status:400}))
      : window.__qaFetch(url, init);`)
  await cdp.click('.modal-footer .btn-primary')
  await cdp.waitFor('.modal-settings .error-banner')
  assert.match(await cdp.eval('document.querySelector(".modal-settings .error-banner").textContent'), /QA simulated save failure/)
  checks.push('设置保存失败在弹窗内可见')
  await fs.writeFile(path.join(qa, 'settings-error.png'), Buffer.from(await cdp.screenshot(), 'base64'))
  await cdp.eval('window.fetch = window.__qaFetch')
  await cdp.click('.modal-settings .modal-header .icon-btn:not([title])')
  await cdp.settle()
  await fs.writeFile(path.join(qa, 'chat-draft.png'), Buffer.from(await cdp.screenshot(), 'base64'))
  const exceptions = cdp.consoleLog.filter((entry) => entry.level === 'exception')
  assert.deepEqual(exceptions, [])
  checks.push('无未捕获页面异常')
  await fs.writeFile(path.join(qa, 'ui-smoke-result.json'), JSON.stringify({ checks, exceptions }, null, 2))
  console.log('UI SMOKE PASS: ' + checks.join('；'))
  // 接着运行现有只读几何矩阵，用环境开关保持当前隔离进程可连接。
  if (process.env.CHATBOT_QA_MATRIX === '1') {
    // 只清理隔离测试本身创建的空会话，保留种子消息供导出场景使用。
    await cdp.eval(`(async () => {
      const conversations = await (await fetch('/api/conversations')).json()
      for (const conversation of conversations) {
        const tree = await (await fetch('/api/conversations/' + conversation.id)).json()
        if (!tree.messages.length) await fetch('/api/conversations/' + conversation.id, {method:'DELETE'})
      }
      location.reload()
    })()`, { awaitPromise: true })
    await cdp.waitFor('.composer textarea', { timeout: 15000 })
    await cdp.settle(1000)
    const matrix = spawn(process.execPath, [path.join(source, '../origin resource/tools/ui-check/run.mjs'),
      '--port', '9334', '--matrix', '--no-diff',
      '--scene', SCENES.filter((s) => s.id !== 'settings-diagnostics').map((s) => s.id).join(','),
      '--out', path.join(qa, 'matrix')], { stdio: 'inherit', windowsHide: true })
    const code = await new Promise((resolve) => matrix.on('exit', resolve))
    if (code !== 0) throw new Error(`UI matrix failed: ${code}`)
  }
} catch (error) {
  if (cdp) {
    await fs.writeFile(path.join(qa, 'ui-failure.png'), Buffer.from(await cdp.screenshot(), 'base64'))
    console.log(await cdp.eval(`JSON.stringify({
      error: document.querySelector('.modal-settings .error-banner')?.textContent,
      modal: !!document.querySelector('.modal-settings'),
      text: document.body.innerText.slice(-2400),
    })`))
    console.log(cdp.consoleLog.filter((entry) => entry.level === 'exception'))
  }
  throw error
} finally {
  if (cdp) {
    try { await cdp.eval('window.close()') } catch {}
    cdp.close()
  }
  for (let i = 0; i < 20 && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 500))
  if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}
