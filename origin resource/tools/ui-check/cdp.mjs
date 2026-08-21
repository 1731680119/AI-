/**
 * 极简 Chrome DevTools Protocol 客户端，用来驱动 Electron 渲染进程做 GUI 检测。
 *
 * 为什么不用 puppeteer/playwright：它们要下载自己的浏览器内核，而我们要测的是
 * 「这个 Electron 版本 + 这份注入脚本」跑出来的真实界面，换个内核就不算数了。
 * 直接连应用自己开的调试端口，测的才是用户看到的那个进程。
 *
 * 零依赖：Node 22+ 自带全局 WebSocket 和 fetch。
 */

const DEFAULT_PORT = 9222

/** 轮询调试端口，直到出现一个可用的页面目标。 */
async function waitForTarget(port, waitMs) {
  const deadline = Date.now() + waitMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      // devtools:// 自己也是一个 target，要排掉；about:blank 是还没加载完的空壳。
      const page = list.find(
        (t) => t.type === 'page'
          && !t.url.startsWith('devtools://')
          && t.url !== 'about:blank'
          && t.webSocketDebuggerUrl,
      )
      if (page) return page
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(
    `等待 ${waitMs}ms 仍未在 127.0.0.1:${port} 找到页面目标。`
    + `请确认应用已带 --remote-debugging-port=${port} 启动，且没有卡在原生崩溃提示弹窗上。`
    + (lastError ? `（最后一次错误：${lastError.message}）` : ''),
  )
}

export async function connect({ port = DEFAULT_PORT, waitMs = 60000 } = {}) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('当前 Node 没有全局 WebSocket，请使用 Node 22 及以上版本运行。')
  }
  const target = await waitForTarget(port, waitMs)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('调试端口握手失败')), { once: true })
  })

  let nextId = 1
  const pending = new Map()
  /** 页面里的 console 输出和未捕获异常，检测报告会带上这些。 */
  const consoleLog = []

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message}（CDP ${msg.error.code}）`))
      else resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(' ')
      consoleLog.push({ level: msg.params.type, text })
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      consoleLog.push({
        level: 'exception',
        text: d.exception?.description || d.text || '未知异常',
      })
    }
  })

  function send(method, params = {}) {
    const id = nextId++
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`CDP ${method} 超时（30s）`))
        }
      }, 30000)
    })
  }

  await send('Runtime.enable')
  await send('Page.enable')

  const session = {
    target,
    consoleLog,
    send,

    /** 在页面里求值，返回 JS 原始值（对象会按值序列化回来）。 */
    async eval(expression, { awaitPromise = false } = {}) {
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
        // 有些操作（如 .click()）在没有用户手势时会被拦，这一项让页面把它当真实手势。
        userGesture: true,
      })
      if (r.exceptionDetails) {
        throw new Error(
          `页面求值出错：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`,
        )
      }
      return r.result.value
    },

    /** 求值并把返回的 JSON 字符串解析成对象。规则脚本用这条路，避免深层结构被裁剪。 */
    async evalJson(expression) {
      const raw = await session.eval(expression)
      return typeof raw === 'string' ? JSON.parse(raw) : raw
    },

    /**
     * 以 globalThis 为 this 调用一个函数声明，参数按值传。
     * 用于传超大字符串（截图 base64），比拼进 expression 里干净得多。
     */
    async callFunction(functionDeclaration, args = [], { awaitPromise = true } = {}) {
      const globalRef = await send('Runtime.evaluate', { expression: 'globalThis' })
      const r = await send('Runtime.callFunctionOn', {
        objectId: globalRef.result.objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise,
      })
      if (r.exceptionDetails) {
        throw new Error(
          `页面函数调用出错：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`,
        )
      }
      return r.result.value
    },

    /** 截图，返回 base64 PNG。 */
    async screenshot() {
      const r = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      })
      return r.data
    },

    /**
     * 真实鼠标点击：先量出元素中心坐标，再派发 CDP 输入事件。
     * 不用 el.click()，因为那样绕过了命中测试——元素被别的层挡住时照样"点得到"，
     * 而"被挡住"恰恰是 GUI 检测最该发现的问题。
     */
    async click(selector, options) {
      return session.clickTarget(
        `document.querySelector(${JSON.stringify(selector)})`,
        { label: selector, ...options },
      )
    },

    /** 按可见文字点击，用于「设置」左侧那种没有稳定 class 的导航项。 */
    async clickByText(selector, text, options) {
      const finder = `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`
        + `.find((n) => (n.textContent || '').trim().includes(${JSON.stringify(text)}))`
      return session.clickTarget(finder, { label: `${selector} 含「${text}」`, ...options })
    },

    /** click / clickByText 的共同实现：finderExpr 是一段返回元素的 JS。 */
    async clickTarget(finderExpr, { optional = false, label = finderExpr } = {}) {
      const box = await session.evalJson(`(() => {
        const el = (${finderExpr})
        if (!el) return 'null'
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return 'null'
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
      })()`)
      if (!box) {
        if (optional) return false
        throw new Error(`找不到可点击的元素：${label}`)
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type, x: box.x, y: box.y, button: 'left', clickCount: 1,
        })
      }
      return true
    },

    /**
     * 真实键盘输入。必须走 Input.insertText 而不是给 .value 赋值：
     * React 受控组件监听的是真实 input 事件，直接改 value 它根本不知道。
     */
    async type(selector, text) {
      await session.eval(`document.querySelector(${JSON.stringify(selector)})?.focus()`)
      await send('Input.insertText', { text })
    },

    async key(name) {
      const map = {
        Enter: { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' },
        Escape: { windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
        Backspace: { windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' },
        Tab: { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' },
      }
      const k = map[name]
      if (!k) throw new Error(`未支持的按键：${name}`)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...k })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k })
    },

    /** 改视口尺寸。D 档矩阵靠它跑多分辨率。 */
    async setViewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      })
    },

    async clearViewport() {
      await send('Emulation.clearDeviceMetricsOverride')
    },

    /** 等元素出现（或消失）。 */
    async waitFor(selector, { timeout = 5000, gone = false } = {}) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const found = await session.eval(
          `!!document.querySelector(${JSON.stringify(selector)})`,
        )
        if (found !== gone) return true
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error(`等待元素${gone ? '消失' : '出现'}超时：${selector}`)
    },

    /** 等到两帧渲染完成，保证 CSS 过渡已经落定再截图。 */
    async settle(extraMs = 250) {
      await session.eval(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
        { awaitPromise: true },
      )
      if (extraMs > 0) await new Promise((r) => setTimeout(r, extraMs))
    },

    close() {
      ws.close()
    },
  }

  return session
}
