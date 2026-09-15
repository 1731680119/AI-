import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// 测真实 store/API 实现，只替换网络和诊断输出。无真实用户数据或付费请求。
const built = await build({
  stdin: { contents: `export { useStore } from './src/store/useAppStore';
    export { streamChat } from './src/services/api/chat';
    export { errorMessage } from './src/services/api/http';
    export { activePathOf } from './src/features/chat/exportConversation';`,
    resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'quiet-diagnostics', setup(b) {
    b.onResolve({ filter: /(?:services\/diagnostics|^\.\.\/diagnostics)$/ }, () => ({ path: 'diag', namespace: 'mock' }))
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents:
      'export const log=()=>{}, logAction=()=>{}, logWarn=()=>{}, logError=()=>{}, newTraceId=()=>"test";' }))
  } }],
})
const module = { exports: {} }
new Function('module', 'exports', built.outputFiles[0].text)(module, module.exports)
const { useStore, streamChat, activePathOf, errorMessage } = module.exports
const state = () => useStore.getState()
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const tree = (id, messages = [], active_leaf_id = null) => ({ id, title: id, messages, active_leaf_id })
const message = (id, parent_id, role = 'user') => ({ id, parent_id, role, content: id, attachments: [], created_at: '' })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise((resolve) => setImmediate(resolve))
const event = (data) => new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
let calls
beforeEach(() => {
  globalThis.document = { documentElement: { dataset: {} } }
  useStore.setState(useStore.getInitialState(), true)
  useStore.setState({ settings: { theme: 'light', default_model: 'test' } })
  calls = []
  globalThis.fetch = async (url, init) => {
    calls.push([url, init])
    if (url === '/api/conversations') return json([])
    if (url.startsWith('/api/conversations/')) return json(tree(url.split('/').at(-1)))
    throw new Error(`Unexpected request: ${url}`)
  }
})

test('项目接口失败时仍加载核心聊天数据', async () => {
  globalThis.fetch = async (url) => url === '/api/projects' ? json({}, 503)
    : json(url === '/api/settings' ? { theme: 'dark' } : [])
  await state().init()
  assert.equal(state().settings.theme, 'dark')
})

test('新会话创建期间快速连点只创建一次', async () => {
  const pending = deferred()
  globalThis.fetch = async (url, init) => {
    calls.push([url, init])
    if (init?.method === 'POST') return pending.promise
    return json(url === '/api/conversations' ? [] : tree('new-id'))
  }
  const first = state().sendMessage('hello', [])
  assert.equal(state().streaming, true)
  assert.equal(await state().sendMessage('hello', []), false)
  state().stopStreaming()
  pending.resolve(json({ id: 'new-id' }))
  await first
  assert.equal(calls.filter(([, init]) => init?.method === 'POST').length, 1)
  assert.equal(state().streaming, false)
})

test('创建失败保留草稿并释放发送状态', async () => {
  state().patchChatDraft('new', { text: 'do not lose this' })
  globalThis.fetch = async (_url, init) => init?.method === 'POST' ? json({ detail: 'offline' }, 503) : json([])
  assert.equal(await state().sendMessage('do not lose this', []), false)
  assert.equal(state().chatDrafts.new.text, 'do not lose this')
  assert.equal(state().streaming, false)
  assert.match(state().error, /offline/)
})

test('快速切换会话时旧成功响应不能覆盖新会话', async () => {
  const slow = deferred()
  globalThis.fetch = (url) => url.endsWith('/a') ? slow.promise : Promise.resolve(json(tree('b')))
  const a = state().selectConversation('a')
  await state().selectConversation('b')
  slow.resolve(json(tree('a')))
  await a
  assert.equal(state().tree.id, 'b')
})

test('旧失败响应不能清空新会话', async () => {
  const slow = deferred()
  globalThis.fetch = (url) => url.endsWith('/a') ? slow.promise : Promise.resolve(json(tree('b')))
  const a = state().selectConversation('a')
  await state().selectConversation('b')
  slow.resolve(json({}, 404))
  await a
  assert.equal(state().currentId, 'b')
})

test('新建对话使在途选择请求失效', async () => {
  const slow = deferred()
  globalThis.fetch = () => slow.promise
  const a = state().selectConversation('a')
  await state().newConversation()
  slow.resolve(json(tree('a')))
  await a
  assert.equal(state().tree, null)
  assert.equal(state().currentId, null)
})

test('重新生成期间仍保留正确的用户提问与历史路径', async () => {
  const history = [message('u', null), message('a', 'u', 'assistant')]
  useStore.setState({ currentId: 'c', tree: tree('c', history, 'a') })
  let controller
  const fallback = globalThis.fetch
  globalThis.fetch = async (url, init) => url === '/api/chat'
    ? new Response(new ReadableStream({ start(c) { controller = c } })) : fallback(url, init)
  const sending = state().sendMessage('', [], { regenerateFrom: 'a' })
  await tick()
  assert.deepEqual(activePathOf(state().tree).map((m) => m.id), ['u', 'temp-asst'])
  controller.enqueue(event({ type: 'start' }))
  controller.close()
  await sending
})

test('停止期间保持互斥，刷新失败也会释放状态和确认框', async () => {
  useStore.setState({ currentId: 'c', tree: tree('c') })
  let controller
  globalThis.fetch = async (url) => url === '/api/chat'
    ? new Response(new ReadableStream({ start(c) { controller = c } })) : json({}, 503)
  const sending = state().sendMessage('hi', [])
  await tick()
  state().stopStreaming()
  assert.equal(state().streaming, true)
  assert.equal(await state().sendMessage('duplicate', []), false)
  controller.close()
  await sending
  assert.equal(state().streaming, false)
  assert.equal(state().abortCtrl, null)
  assert.equal(state().codeExecRequest, null)
})

test('其他会话的流片段不会写入当前会话', async () => {
  useStore.setState({ currentId: 'c', tree: tree('c') })
  let controller
  const fallback = globalThis.fetch
  globalThis.fetch = async (url, init) => url === '/api/chat'
    ? new Response(new ReadableStream({ start(c) { controller = c } })) : fallback(url, init)
  const sending = state().sendMessage('hi', [])
  await tick()
  await state().selectConversation('b')
  controller.enqueue(event({ type: 'content', text: 'belongs to c' }))
  controller.close()
  await sending
  assert.equal(state().tree.id, 'b')
  assert.deepEqual(state().tree.messages, [])
})

test('分会话草稿在页面切换后保持独立', async () => {
  state().patchChatDraft('a', { text: 'A', attachments: [{ id: 'file-a' }] })
  state().patchChatDraft('b', { text: 'B' })
  state().setMode('image')
  state().setMode('chat')
  assert.equal(state().chatDrafts.a.text, 'A')
  assert.equal(state().chatDrafts.b.text, 'B')
  assert.equal(state().chatDrafts.a.attachments[0].id, 'file-a')
})

test('SSE 支持 CRLF、字节拆分和缺少结尾空行', async () => {
  const text = 'data: {"type":"content","text":"中文"}\r\n\r\ndata: {"type":"done"}'
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) {
    for (const byte of new TextEncoder().encode(text)) c.enqueue(Uint8Array.of(byte))
    c.close()
  } }))
  const events = []
  await streamChat({ conversation_id: 'c' }, (e) => events.push(e))
  assert.deepEqual(events, [{ type: 'content', text: '中文' }, { type: 'done' }])
})

test('SSE 消费者错误不被 JSON 容错吞掉，并释放连接', async () => {
  let cancelled = false
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(event({ type: 'content', text: 'x' })) }, cancel() { cancelled = true },
  }))
  await assert.rejects(streamChat({ conversation_id: 'c' }, () => { throw new Error('consumer bug') }), /consumer bug/)
  assert.equal(cancelled, true)
})

test('错误提示可读且不泄露校验输入', () => {
  assert.equal(errorMessage([{ loc: ['body', 'n'], msg: 'out of range', input: 'secret' }], 'error'), 'n：out of range')
  assert.equal(errorMessage(null, 'fallback'), 'fallback')
})

test('循环消息树不会卡死前端', () => {
  const result = activePathOf(tree('c', [message('a', 'b'), message('b', 'a')], 'b'))
  assert.equal(result.length, 2)
})

const desktopSource = await readFile(new URL('../../../source/desktop/page-enhancements.js', import.meta.url), 'utf8')
const networkSource = desktopSource.slice(0, desktopSource.indexOf('  function selectionTextForElement')) + '\n})()'
function desktopNetwork(originalFetch, overrides = {}) {
  const window = {
    fetch: originalFetch, dispatchEvent() {},
    chatbotDesktop: {
      getApiPlan: async () => ({ attempts: [{ id: 'test', name: 'Test' }], timeoutMs: 10 }),
      beginApiAttempt: async () => 'lock', endApiAttempt: async () => {}, ...overrides,
    },
  }
  vm.runInNewContext(networkSource, { window, TextEncoder, TextDecoder, Response, ReadableStream,
    AbortController, DOMException, FormData, URL, setTimeout, clearTimeout, location: { href: 'http://localhost/' },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail } },
  })
  return window.fetch
}

test('桌面渠道握手期间取消后不再发送上游请求，并释放渠道锁', async () => {
  const pending = deferred()
  let requests = 0, released = 0
  const fetch = desktopNetwork(async () => { requests++; return json({}) }, {
    beginApiAttempt: () => pending.promise, endApiAttempt: async () => { released++ },
  })
  const ctrl = new AbortController()
  const response = await fetch('/api/chat', { method: 'POST', body: '{}', signal: ctrl.signal })
  ctrl.abort()
  pending.resolve('lock')
  await response.text()
  await tick()
  assert.equal(requests, 0)
  assert.equal(released, 1)
})

test('桌面流超时取消原连接', async () => {
  let signal, cancelled = false
  const fetch = desktopNetwork(async (_url, init) => {
    signal = init.signal
    return new Response(new ReadableStream({ cancel() { cancelled = true } }))
  })
  const response = await fetch('/api/chat', { method: 'POST', body: '{}' })
  assert.match(await response.text(), /无响应/)
  assert.equal(signal.aborted, true)
  assert.equal(cancelled, true)
})

test('桌面层也透传缺少结尾空行的 done 事件', async () => {
  const fetch = desktopNetwork(async () => new Response('data: {"type":"done"}'))
  const response = await fetch('/api/chat', { method: 'POST', body: '{}' })
  assert.match(await response.text(), /"type":"done"/)
})
