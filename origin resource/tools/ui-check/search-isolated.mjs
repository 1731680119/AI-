/** 在隔离 Electron 页面验证搜索设置，不读取用户数据或调用付费接口。 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { connect } from './cdp.mjs'

const backend = fileURLToPath(new URL('../../backend/', import.meta.url))
const source = fileURLToPath(new URL('../../../source/', import.meta.url))
const qa = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbot-search-ui-'))
const freePort = () => new Promise(resolve => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => resolve(port))
  })
})
const port = await freePort()
const debugPort = await freePort()
const env = { ...process.env, CHATBOT_DATA_DIR: path.join(qa, 'data'),
  CHATBOT_LOG_DIR: path.join(qa, 'logs'), PYTHON_DOTENV_DISABLED: '1', OPENAI_API_KEY: '',
  CHATBOT_FRONTEND_DIST: fileURLToPath(new URL('../../frontend/dist/', import.meta.url)) }
delete env.ELECTRON_RUN_AS_NODE
const service = spawn(path.join(backend, '.venv/Scripts/python.exe'), ['desktop_server.py', '--port', String(port)],
  { cwd: backend, env, windowsHide: true, stdio: 'ignore' })
let electron, cdp
const base = `http://127.0.0.1:${port}`
const checks = []
try {
  const deadline = Date.now() + 30000
  while (true) {
    try { if ((await fetch(base + '/api/health')).ok) break } catch {}
    assert(Date.now() < deadline && service.exitCode === null, 'isolated backend did not start')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const search = { id: 'qa-search', name: '千问测试', protocol: 'qwen',
    base_url: 'https://space.cn-beijing.maas.aliyuncs.com/api/v1', api_key: 'qa-fake-only',
    model: 'qwen3.5-plus', api_type: 'auto', search_strategy: 'agent_max', max_output_tokens: 4000 }
  assert((await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tools_enabled: true, search_providers: [search], search_provider_id: search.id }) })).ok)
  await fs.writeFile(path.join(qa, 'package.json'), JSON.stringify({ name: 'search-qa', version: '1.0.0', main: 'main.cjs' }))
  await fs.writeFile(path.join(qa, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData', ${JSON.stringify(path.join(qa, 'electron-data'))});
    app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1280,height:960,webPreferences:{backgroundThrottling:false,offscreen:true}});win.loadURL(${JSON.stringify(base)});});
    app.on('window-all-closed',()=>app.quit());`)
  electron = spawn(path.join(source, 'node_modules/electron/dist/electron.exe'), [qa, `--remote-debugging-port=${debugPort}`],
    { env, windowsHide: true, stdio: 'ignore' })
  cdp = await connect({ port: debugPort, waitMs: 30000 })
  await cdp.waitFor('.sidebar-footer button', { timeout: 15000 })
  await cdp.clickByText('.sidebar-footer button', '设置')
  await cdp.waitFor('.modal-settings')
  await cdp.clickByText('.settings-nav button', '联网搜索')
  await cdp.waitFor('.search-provider')
  const fields = () => cdp.eval(`Array.from(document.querySelector('.search-provider').querySelectorAll('.field')).map(f=>({label:f.querySelector('label')?.textContent,value:f.querySelector('input,select')?.value,options:Array.from(f.querySelectorAll('option')).map(o=>o.value)}))`)
  const setField = async (label, value) => {
    await cdp.eval(`(()=>{const field=Array.from(document.querySelector('.search-provider').querySelectorAll('.field')).find(f=>f.querySelector('label')?.textContent===${JSON.stringify(label)});
      const el=field.querySelector('input,select'); Object.getOwnPropertyDescriptor(el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});
      el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
    await cdp.settle(100)
  }
  let state = await fields()
  assert.deepEqual(state.find(f => f.label === '搜索策略').options, ['turbo', 'max', 'agent', 'agent_max'])
  await setField('搜索模型', 'qwen3.8-max')
  state = await fields()
  assert.deepEqual(state.find(f => f.label === '搜索策略').options, ['turbo', 'max'])
  assert.equal(state.find(f => f.label === '搜索策略').value, 'turbo')
  checks.push('Qwen3.8 hides unsupported strategies and replaces agent_max with turbo')
  await setField('搜索模型', 'qwen3.5-omni-plus')
  assert.deepEqual((await fields()).find(f => f.label === '搜索策略').options, ['agent'])
  checks.push('Omni exposes only agent')
  await setField('搜索模型', 'qwen3.8-max')
  await setField('API 类型', 'responses')
  assert(!(await fields()).some(f => f.label === '搜索策略'))
  assert.match(await cdp.eval(`document.querySelector('.search-provider').innerText`), /不发送 search_strategy/)
  checks.push('Responses hides search_strategy')
  await setField('搜索模型', 'qwen-plus')
  assert.equal((await fields()).find(f => f.label === 'API 类型').value, 'dashscope')
  checks.push('Changing to qwen-plus replaces unsupported Responses API')
  await cdp.eval(`window.__qaRequests=[]; const original=window.fetch; window.fetch=(url,init)=>{
    if(String(url).endsWith('/settings/model-list')){window.__qaRequests.push(JSON.parse(init.body));return Promise.resolve(new Response(JSON.stringify({ok:true,models:['qwen-plus','qwen3.8-max'],endpoint:'QA listing',message:'QA candidates'}),{headers:{'Content-Type':'application/json'}}));}
    return original(url,init);};`)
  await cdp.clickByText('.search-provider .model-probe-btn', '获取模型')
  await cdp.waitFor('.model-picker-row')
  assert.equal((await cdp.eval('window.__qaRequests'))[0].protocol, 'qwen')
  assert.equal((await cdp.eval('window.__qaRequests'))[0].api_type, 'dashscope')
  checks.push('Model picker sends search protocol and API type')
  await cdp.click('.model-picker-head button[title="关闭"]')
  await cdp.click('.modal-footer .btn-primary')
  await cdp.waitFor('.modal-settings', { gone: true })
  const saved = await (await fetch(base + '/api/settings')).json()
  assert.equal(saved.search_providers[0].api_type, 'dashscope')
  assert.equal(saved.search_providers[0].search_strategy, 'turbo')
  checks.push('Saving preserves adapted API and strategy')
  await cdp.clickByText('.sidebar-footer button', '设置')
  await cdp.waitFor('.modal-settings')
  await cdp.clickByText('.settings-nav button', '联网搜索')
  await setField('搜索协议', '')
  await setField('API 地址（Base URL）', 'https://api.z.ai/api/paas/v4')
  assert(!(await fields()).some(f => f.label === '搜索模型'))
  assert.match(await cdp.eval(`document.querySelector('.search-provider').innerText`), /search-prime/)
  checks.push('Z.AI host overrides stale Qwen name and uses search-prime without model picker')
  await setField('API 地址（Base URL）', 'https://open.bigmodel.cn/api/paas/v4')
  assert.match(await cdp.eval(`document.querySelector('.search-provider').innerText`), /search_pro.*70/)
  checks.push('Domestic GLM shows search_pro and query limit')
  await setField('API 地址（Base URL）', 'https://api.moonshot.cn/v1/tools/search_pro')
  assert(!(await fields()).some(f => f.label === '搜索模型'))
  assert.match(await cdp.eval(`document.querySelector('.search-provider').innerText`), /search_pro（Pro）/)
  checks.push('Kimi Pro uses standalone search without model picker')
  await setField('API 地址（Base URL）', 'https://api.deepseek.com/v1')
  assert(!(await fields()).some(f => f.label === '搜索模型'))
  assert.equal(await cdp.eval(`document.querySelector('.search-test-btn').disabled`), true)
  assert.match(await cdp.eval(`document.querySelector('.search-provider').innerText`), /不支持内置联网搜索/)
  checks.push('Official DeepSeek hides search models and disables misleading search test')
  assert.deepEqual(cdp.consoleLog.filter(entry => entry.level === 'exception'), [])
  await fs.writeFile(path.join(qa, 'result.json'), JSON.stringify({ checks }, null, 2))
  console.log(JSON.stringify({ qa, checks }, null, 2))
} catch (error) {
  console.error(error)
  if (cdp) {
    try { console.log(await cdp.eval('document.body.innerText.slice(-4500)')) } catch {}
  }
  throw error
} finally {
  if (cdp) { try { await cdp.eval('window.close()') } catch {} cdp.close() }
  for (const child of [electron, service]) if (child && child.exitCode === null)
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}
