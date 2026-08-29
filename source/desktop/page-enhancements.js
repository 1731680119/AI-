(() => {
  if (window.__aiChatbotEnhancementsLoaded || !window.chatbotDesktop) return
  window.__aiChatbotEnhancementsLoaded = true

  const desktop = window.chatbotDesktop
  const originalFetch = window.fetch.bind(window)
  const encoder = new TextEncoder()

  function sseEvent(payload) {
    return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
  }

  function apiErrorResponse(message) {
    return new Response(JSON.stringify({ detail: message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async function readWithIdleTimeout(reader, timeoutMs, signal) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`API 超过 ${Math.round(timeoutMs / 1000)} 秒无响应`)), timeoutMs)
    })
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      return await Promise.race([reader.read(), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  function parseEventBlock(block) {
    const line = block.split(/\r?\n/).find((item) => item.trim().startsWith('data:'))
    if (!line) return null
    try { return JSON.parse(line.trim().slice(5).trim()) } catch { return null }
  }

  // 只打选中的那一个 API。以前这里会按列表顺序轮着试，结果是：真实原因被
  // 「所有 API 均不可用」四条错误糊在一起，而且串着等四次让人以为是超时
  //（实际每次都只花一两秒就被 400 顶回来了）。现在选了谁就只调谁，它报什么
  // 就原样呈现什么。
  async function runChatRequest(controller, input, init, body, model, plan) {
    const api = plan.attempts[0]
    let token = null
    let reader = null
    let sawDone = false
    let failureMessage = ''
    const requestController = new AbortController()
    const abortFromCaller = () => requestController.abort(init.signal?.reason)
    init.signal?.addEventListener('abort', abortFromCaller, { once: true })
    try {
      token = await desktop.beginApiAttempt({ apiId: api.id, model })
      let response
      try {
        response = await originalFetch(input, { ...init, signal: requestController.signal })
      } finally {
        if (token) {
          await desktop.endApiAttempt(token).catch(() => {})
          token = null
        }
      }
      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }))
        throw new Error(detail.detail || detail.message || `HTTP ${response.status}`)
      }

      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await readWithIdleTimeout(reader, plan.timeoutMs, init.signal)
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() || ''
        for (const block of blocks) {
          const event = parseEventBlock(block)
          if (!event) continue
          if (event.type === 'error') {
            // 错误事件照常放给前端：不再需要攒起来等着拼汇总。
            failureMessage = event.message || '请求失败'
            controller.enqueue(sseEvent(event))
          } else {
            if (event.type === 'done') sawDone = true
            controller.enqueue(sseEvent(event))
          }
        }
      }
      if (!failureMessage && !sawDone) failureMessage = 'API 响应意外中断'
    } catch (error) {
      if (init.signal?.aborted || error?.name === 'AbortError') {
        try { await reader?.cancel() } catch {}
        controller.close()
        return
      }
      failureMessage = error?.message || String(error)
      // 连接层的失败（打不通、超时、非 200）后端不会发 error 事件，这里补一个。
      controller.enqueue(sseEvent({ type: 'error', message: failureMessage }))
    } finally {
      init.signal?.removeEventListener('abort', abortFromCaller)
      if (token) await desktop.endApiAttempt(token).catch(() => {})
    }

    if (failureMessage) {
      window.dispatchEvent(new CustomEvent('chatbot-api-failures', {
        detail: {
          failures: [{ api: api.name, message: failureMessage }],
          summary: `${api.name}：${failureMessage}`,
        },
      }))
    }
    controller.close()
  }

  /**
   * 图片生成 / 编辑：和聊天走同一套「临时写渠道 → 发请求 → 清掉」的握手，
   * 只是写的是 image_base_url / image_api_key，而且响应是普通 JSON 不是 SSE，
   * 所以原样透传即可。
   *
   * 渠道 id 从请求体里取（generate 是 JSON 的 api_id，edit 是表单的 api_id），
   * 取不到就退回主进程「谁声明了这个模型就用谁」的判断。
   */
  const IMAGE_PATHS = new Set(['/api/images/generate', '/api/images/edit'])

  function imageRequestFields(init) {
    const body = init?.body
    if (body instanceof FormData) {
      return { apiId: String(body.get('api_id') || ''), model: String(body.get('model') || '') }
    }
    try {
      const parsed = JSON.parse(body)
      return { apiId: String(parsed.api_id || ''), model: String(parsed.model || '') }
    } catch {
      return { apiId: '', model: '' }
    }
  }

  async function runImageRequest(input, init) {
    const { apiId, model } = imageRequestFields(init)
    let plan
    try {
      plan = await desktop.getApiPlan(apiId ? { model, apiId } : model)
    } catch (error) {
      return apiErrorResponse(error?.message || String(error))
    }
    if (!plan.attempts.length) {
      return apiErrorResponse('没有已启用的 API，请先打开设置添加 API。')
    }
    let token = null
    try {
      token = await desktop.beginApiAttempt({ apiId: plan.attempts[0].id, model, target: 'image' })
    } catch (error) {
      return apiErrorResponse(error?.message || String(error))
    }
    try {
      // 这里必须等整个响应回来才放锁：画一张图动辄几十秒，提前放锁会让下一次
      // 请求把 image_api_key 改掉。主进程那个 45 秒看门狗是兜底，真到点了也只是
      // 提前放锁——后端早就拿着密钥建好客户端了，在途的这次请求不受影响。
      return await originalFetch(input, init)
    } finally {
      await desktop.endApiAttempt(token).catch(() => {})
    }
  }

  window.fetch = async function enhancedFetch(input, init = {}) {
    const requestUrl = typeof input === 'string' ? input : input?.url || ''
    let parsed
    try { parsed = new URL(requestUrl, location.href) } catch { return originalFetch(input, init) }
    const method = String(init.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase()
    if (method !== 'POST') return originalFetch(input, init)
    if (IMAGE_PATHS.has(parsed.pathname)) return runImageRequest(input, init)
    if (parsed.pathname !== '/api/chat') return originalFetch(input, init)

    let body
    try { body = JSON.parse(init.body) } catch { return originalFetch(input, init) }
    const model = String(body.model || '')
    // api_id 是前端在模型选择器里选中的那个渠道。老版本前端不带这个字段，
    // 此时退回主进程里「谁声明了这个模型就用谁」的判断，界面照旧能用。
    const apiId = String(body.api_id || '')
    let plan = null
    try {
      plan = await desktop.getApiPlan(apiId ? { model, apiId } : model)
    } catch (error) {
      return apiErrorResponse(error?.message || String(error))
    }
    const enhancedInit = init
    if (!plan.attempts.length) {
      setTimeout(() => window.dispatchEvent(new CustomEvent('chatbot-api-failures', {
        detail: { failures: [], summary: '没有已启用的 API，请先打开设置添加 API。' },
      })), 0)
      return apiErrorResponse('没有已启用的 API，请先打开设置添加 API。')
    }
    const stream = new ReadableStream({
      start(controller) {
        runChatRequest(controller, input, enhancedInit, body, model, plan).catch((error) => {
          controller.enqueue(sseEvent({ type: 'error', message: error?.message || String(error) }))
          controller.close()
        })
      },
    })
    // 这里原来还挂一个 aiChatbotFailover 标记，整个仓库没有任何地方读它，
    // 名字也是轮询时代留下的，一并去掉。
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  function selectionTextForElement(target) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = target.selectionStart ?? 0
      const end = target.selectionEnd ?? start
      return start !== end ? target.value.slice(start, end) : ''
    }
    return window.getSelection()?.toString() || ''
  }

  function contextPayload(target, selectionOnly = false) {
    const selected = selectionTextForElement(target).trim()
    const codeContainer = target.closest('.code-block, .artifact-code, pre')
    const isCode = Boolean(codeContainer)
    if (selected) return { text: selected, isCode }
    if (selectionOnly) return null
    if (codeContainer) {
      const code = codeContainer.querySelector('code') || codeContainer.querySelector('pre') || codeContainer
      const text = code.textContent?.trim()
      return text ? { text, isCode: true } : null
    }
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const text = target.value.trim()
      return text ? { text, isCode: false } : null
    }
    const row = target.closest('.msg-row')
    if (!row) return null
    const content = row.classList.contains('user')
      ? row.querySelector('.user-bubble:not(.editing)')
      : row.querySelector('.md')
    const text = content?.textContent?.trim()
    return text ? { text, isCode: false } : null
  }

  document.addEventListener('contextmenu', (event) => {
    const payload = contextPayload(event.target)
    if (!payload) return
    event.preventDefault()
    desktop.showContextMenu(payload)
  }, true)

  function showToast(message) {
    let toast = document.querySelector('.enh-toast')
    if (!toast) {
      toast = document.createElement('div')
      toast.className = 'enh-toast'
      document.body.appendChild(toast)
    }
    toast.textContent = message
    toast.classList.add('visible')
    clearTimeout(showToast.timer)
    showToast.timer = setTimeout(() => toast.classList.remove('visible'), 2600)
  }

  const waitingMessages = new Map()
  function showWaiting(key, message) {
    if (waitingMessages.get(key) === message && document.querySelector('.enh-waiting.visible')) return
    waitingMessages.set(key, message)
    let box = document.querySelector('.enh-waiting')
    if (!box) {
      box = document.createElement('div')
      box.className = 'enh-waiting'
      box.setAttribute('role', 'status')
      box.setAttribute('aria-live', 'polite')
      document.body.appendChild(box)
    }
    box.replaceChildren()
    const spinner = document.createElement('span')
    spinner.className = 'enh-waiting-spinner'
    const text = document.createElement('span')
    text.textContent = [...waitingMessages.values()][0] || message
    box.append(spinner, text)
    box.classList.add('visible')
  }

  function hideWaiting(key) {
    waitingMessages.delete(key)
    const box = document.querySelector('.enh-waiting')
    if (!box) return
    const next = [...waitingMessages.values()][0]
    if (!next) {
      box.classList.remove('visible')
      return
    }
    box.querySelector('span:last-child').textContent = next
  }

  // 这里原来监听 chatbot-api-match-waiting / -complete 两个事件，给轮询选渠道
  // 的过程显示「正在选择适合的 API」。现在只打用户选中的那一个渠道，没有可选
  // 过程，两个事件已全部删除——别再加回来。

  function syncNativeWaitingIndicators() {
    const backendStarting = [...document.querySelectorAll('.error-banner')]
      .some((item) => item.textContent.includes('正在等待后端服务启动'))
    const uploading = Boolean(document.querySelector('.uploading-label'))
    const generatingImage = [...document.querySelectorAll('.image-submit')]
      .some((item) => item.textContent.includes('生成中'))
    const saving = [...document.querySelectorAll('.modal-footer .btn-primary')]
      .some((item) => item.textContent.includes('保存中'))
    if (backendStarting) showWaiting('backend-startup', '正在启动本地服务，请稍候…')
    else hideWaiting('backend-startup')
    if (uploading) showWaiting('file-upload', '正在处理上传的文件，请稍候…')
    else hideWaiting('file-upload')
    if (generatingImage) showWaiting('image-generation', '正在生成图片，请稍候…')
    else hideWaiting('image-generation')
    if (saving) showWaiting('settings-save', '正在保存设置，请稍候…')
    else hideWaiting('settings-save')
  }

  let nativeWaitingFrame = null
  const nativeWaitingObserver = new MutationObserver(() => {
    if (nativeWaitingFrame !== null) return
    nativeWaitingFrame = requestAnimationFrame(() => {
      nativeWaitingFrame = null
      syncNativeWaitingIndicators()
    })
  })
  nativeWaitingObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled'],
  })

  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'd') return
    event.preventDefault()
    const payload = contextPayload(event.target, true)
    if (!payload) {
      showToast('请先选择要询问的内容')
      return
    }
    desktop.openDeepseek({ action: 'ask', text: payload.text })
  }, true)

  function renderDeepseekTabs(payload) {
    const tabs = payload?.tabs || []
    document.body.classList.toggle('enhancement-tabs-open', tabs.length > 0)
    let bar = document.querySelector('.enh-tabbar')
    if (!tabs.length) {
      bar?.remove()
      return
    }
    if (!bar) {
      bar = document.createElement('div')
      bar.className = 'enh-tabbar'
      document.body.appendChild(bar)
    }
    bar.replaceChildren()
    const chat = document.createElement('button')
    chat.className = `enh-tab ${payload.activeId ? '' : 'active'}`
    chat.textContent = '聊天'
    chat.addEventListener('click', () => desktop.selectDeepseekTab(null))
    bar.appendChild(chat)
    for (const tab of tabs) {
      const item = document.createElement('div')
      item.className = `enh-tab ${payload.activeId === tab.id ? 'active' : ''}`
      const title = document.createElement('button')
      title.className = 'enh-tab-title'
      title.textContent = tab.title
      title.addEventListener('click', () => desktop.selectDeepseekTab(tab.id))
      const close = document.createElement('button')
      close.className = 'enh-tab-close'
      close.textContent = '×'
      close.title = '关闭标签页'
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        desktop.closeDeepseekTab(tab.id)
      })
      item.append(title, close)
      bar.appendChild(item)
    }
  }

  desktop.onDeepseekTabs(renderDeepseekTabs)

  function openSettings() {
    const buttons = [...document.querySelectorAll('.sidebar-footer button')]
    const button = buttons.find((item) => item.textContent.includes('设置')) || buttons.at(-1)
    button?.click()
  }

  function retryCurrentMessage() {
    const attempt = () => {
      const button = document.querySelector('.send-btn')
      if (button && !button.disabled && !button.title?.includes('停止')) button.click()
      else setTimeout(attempt, 250)
    }
    setTimeout(attempt, 150)
  }

  function showApiFailureDialog(detail) {
    document.querySelector('.enh-failure-overlay')?.remove()
    const overlay = document.createElement('div')
    overlay.className = 'enh-failure-overlay'
    const card = document.createElement('div')
    card.className = 'enh-failure-card'
    const title = document.createElement('h3')
    // 现在只调选中的那一个 API，所以标题说的是「这个 API 失败了」，
    // 而不是以前那句会误导人的「所有 API 均不可用」。
    const failedName = detail.failures?.[0]?.api
    title.textContent = failedName ? `${failedName} 调用失败` : '请求失败'
    const pre = document.createElement('pre')
    pre.textContent = detail.summary
    const actions = document.createElement('div')
    actions.className = 'enh-failure-actions'
    const retry = document.createElement('button')
    retry.className = 'btn-primary'
    retry.textContent = '重新尝试'
    retry.addEventListener('click', () => { overlay.remove(); retryCurrentMessage() })
    const settings = document.createElement('button')
    settings.className = 'btn-ghost'
    settings.textContent = '打开 API 设置'
    settings.addEventListener('click', () => { overlay.remove(); openSettings() })
    const close = document.createElement('button')
    close.className = 'btn-ghost'
    close.textContent = '关闭'
    close.addEventListener('click', () => overlay.remove())
    actions.append(retry, settings, close)
    card.append(title, pre, actions)
    overlay.appendChild(card)
    document.body.appendChild(overlay)
  }

  window.addEventListener('chatbot-api-failures', (event) => showApiFailureDialog(event.detail))

  function createInput(label, value, onInput, options = {}) {
    const field = document.createElement('div')
    field.className = 'field'
    const caption = document.createElement('label')
    caption.textContent = label
    const input = options.multiline ? document.createElement('textarea') : document.createElement('input')
    if (options.multiline) input.rows = options.rows || 3
    if (options.type) input.type = options.type
    if (options.placeholder) input.placeholder = options.placeholder
    input.value = value ?? ''
    input.addEventListener('input', () => onInput(input.value))
    field.append(caption, input)
    return { field, input }
  }

  // 拖动 API 卡片排序时，指针靠近滚动容器上下边缘就自动滚动，
  // 速度由离边缘的距离决定：刚进触发区最慢，贴边最快。
  const DRAG_SCROLL_ZONE = 60
  const DRAG_SCROLL_MIN_SPEED = 2
  const DRAG_SCROLL_MAX_SPEED = 18
  const dragScroll = { target: null, speed: 0, frame: 0 }

  function scrollableAncestor(node) {
    for (let el = node; el && el !== document.body; el = el.parentElement) {
      const overflowY = getComputedStyle(el).overflowY
      if (/(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight + 1) return el
    }
    return document.scrollingElement || document.documentElement
  }
  function stepDragScroll() {
    dragScroll.frame = 0
    if (!dragScroll.target || !dragScroll.speed) return
    const before = dragScroll.target.scrollTop
    dragScroll.target.scrollTop = before + dragScroll.speed
    // 已经滚到顶/底就停下，别让 rAF 空转。指针再动时会重新拉起。
    if (dragScroll.target.scrollTop === before) return
    dragScroll.frame = requestAnimationFrame(stepDragScroll)
  }

  function updateDragScroll(clientY) {
    const target = dragScroll.target
    if (!target) return
    const rect = target === document.scrollingElement || target === document.documentElement
      ? { top: 0, bottom: window.innerHeight, height: window.innerHeight }
      : target.getBoundingClientRect()
    // 容器很矮时按高度的三分之一收窄，免得上下触发区连成一片。
    const zone = Math.min(DRAG_SCROLL_ZONE, rect.height / 3)
    const fromTop = clientY - rect.top
    const fromBottom = rect.bottom - clientY
    let speed = 0
    if (zone > 0) {
      // ratio：刚进触发区为 0，贴到边缘为 1；指针越过边缘后保持最大速度。
      if (fromTop < zone && fromTop > -zone) {
        const ratio = Math.min(Math.max((zone - fromTop) / zone, 0), 1)
        speed = -(DRAG_SCROLL_MIN_SPEED + (DRAG_SCROLL_MAX_SPEED - DRAG_SCROLL_MIN_SPEED) * ratio)
      } else if (fromBottom < zone && fromBottom > -zone) {
        const ratio = Math.min(Math.max((zone - fromBottom) / zone, 0), 1)
        speed = DRAG_SCROLL_MIN_SPEED + (DRAG_SCROLL_MAX_SPEED - DRAG_SCROLL_MIN_SPEED) * ratio
      }
    }
    dragScroll.speed = speed
    if (speed && !dragScroll.frame) dragScroll.frame = requestAnimationFrame(stepDragScroll)
  }

  // 监听器挂在 document 上而不是卡片上：拖动过程中卡片会被平移，
  // 指针可能已经不在它上面了，挂在卡片上会漏事件。
  function onDocumentPointerMove(event) {
    updateDragScroll(event.clientY)
  }

  function beginDragScroll(node) {
    dragScroll.target = scrollableAncestor(node)
    document.addEventListener('pointermove', onDocumentPointerMove, true)
  }

  function stopDragScroll() {
    document.removeEventListener('pointermove', onDocumentPointerMove, true)
    if (dragScroll.frame) cancelAnimationFrame(dragScroll.frame)
    dragScroll.frame = 0
    dragScroll.target = null
    dragScroll.speed = 0
  }

  /**
   * 指针拖动排序。
   *
   * 为什么不用 HTML5 drag&drop：它的拖影是浏览器截的静态位图，改不了大小和
   * 透明度，也没法让下面的项目实时让位——要「缩小半透明跟随鼠标 + 原位留占位框
   * + 相邻项被顶开」这套效果，只能自己接指针事件。
   *
   * 交互约定：
   * - 只有在手柄（`handleSelector`）上按下才起拖，否则卡片里的输入框没法选中文本。
   * - 指针移动超过 `DRAG_THRESHOLD` 才真正开始，避免「想点一下」被判成拖动。
   * - 被拖的那项原地留下，降透明度当占位框；另外克隆一份缩小后跟随指针。
   * - 其余项按指针**越过中线**判定让位（`transform` 平移，带过渡），
   *   松手时按最终落点写回顺序。
   *
   * 中线判定用的是**元素原始位置**（`baseTop`，进入拖动时快照的），不是实时的
   * `getBoundingClientRect()`——后者已经被让位的 transform 改过了，拿它算会来回抖。
   *
   * `options.onReorder(from, to)` 在顺序真的变了时调用；`items()` 返回参与排序的
   * 元素数组（顺序即当前顺序）。
   */
  const DRAG_THRESHOLD = 4

  function makeSortable(container, { handleSelector, onReorder }) {
    container.addEventListener('pointerdown', (event) => {
      // 只响应主键；右键和中键交给默认行为。
      if (event.button !== 0) return
      const handle = event.target.closest(handleSelector)
      if (!handle || !container.contains(handle)) return
      const source = handle.closest('[data-sort-index]')
      if (!source) return

      const items = [...container.querySelectorAll('[data-sort-index]')]
      const fromIndex = items.indexOf(source)
      if (fromIndex < 0) return

      const startX = event.clientX
      const startY = event.clientY
      let started = false
      let ghost = null
      let toIndex = fromIndex
      let offsetX = 0
      let offsetY = 0
      // 每一项的原始位置和高度，进入拖动时快照一次。
      let layout = []
      // 让位时相邻项要移动的距离 = 被拖项高度 + 列表间距。
      let shift = 0

      const begin = () => {
        started = true
        const rect = source.getBoundingClientRect()
        const gap = parseFloat(getComputedStyle(container).rowGap || '0') || 0
        shift = rect.height + gap
        layout = items.map((node) => {
          const box = node.getBoundingClientRect()
          return { node, baseTop: box.top, height: box.height }
        })

        // 跟随指针的那份：克隆而不是移动原节点，原节点要留在原位当占位框。
        ghost = source.cloneNode(true)
        ghost.classList.add('enh-sort-ghost')
        ghost.style.width = `${rect.width}px`
        ghost.style.height = `${rect.height}px`
        document.body.appendChild(ghost)
        offsetX = startX - rect.left
        offsetY = startY - rect.top
        moveGhost(startX, startY)

        source.classList.add('enh-sort-placeholder')
        for (const node of items) node.classList.add('enh-sort-shifting')
        document.body.classList.add('enh-sorting')
        beginDragScroll(container)
      }

      const moveGhost = (clientX, clientY) => {
        // 缩到 0.94 并让缩放锚点跟着指针走，视觉上像是"抓起来了一点"。
        ghost.style.transform =
          `translate(${clientX - offsetX}px, ${clientY - offsetY}px) scale(.94)`
      }

      /**
       * 按指针位置算出应该插到第几位，并把让位的 transform 刷上去。
       *
       * 用被拖项的**中心**跟其它项的中线比：指针位置本身取决于用户从卡片哪里
       * 按下的手柄，用它会导致同样的视觉位置在不同卡片上判定不一致。
       */
      const updateOrder = (clientY) => {
        const draggedCenter = clientY - offsetY + layout[fromIndex].height / 2
        let next = fromIndex
        for (let i = 0; i < layout.length; i += 1) {
          if (i === fromIndex) continue
          const middle = layout[i].baseTop + layout[i].height / 2
          if (i < fromIndex && draggedCenter < middle) { next = Math.min(next, i); }
          if (i > fromIndex && draggedCenter > middle) { next = Math.max(next, i); }
        }
        if (next === toIndex) return
        toIndex = next
        for (let i = 0; i < layout.length; i += 1) {
          if (i === fromIndex) continue
          // 往上拖：区间 [toIndex, fromIndex) 里的项整体下移一格；
          // 往下拖：区间 (fromIndex, toIndex] 里的项整体上移一格。
          let delta = 0
          if (toIndex < fromIndex && i >= toIndex && i < fromIndex) delta = shift
          if (toIndex > fromIndex && i > fromIndex && i <= toIndex) delta = -shift
          layout[i].node.style.transform = delta ? `translateY(${delta}px)` : ''
        }
      }

      const onMove = (moveEvent) => {
        if (!started) {
          const moved = Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY)
          if (moved < DRAG_THRESHOLD) return
          begin()
        }
        moveEvent.preventDefault()
        moveGhost(moveEvent.clientX, moveEvent.clientY)
        updateOrder(moveEvent.clientY)
      }

      const finish = (commit) => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onCancel, true)
        if (!started) return
        stopDragScroll()
        ghost?.remove()
        source.classList.remove('enh-sort-placeholder')
        document.body.classList.remove('enh-sorting')
        for (const item of layout) {
          item.node.classList.remove('enh-sort-shifting')
          item.node.style.transform = ''
        }
        // 顺序没变就不必重绘，省得输入框里正在编辑的内容被打断。
        if (commit && toIndex !== fromIndex) onReorder(fromIndex, toIndex)
      }

      const onUp = () => finish(true)
      const onCancel = () => finish(false)

      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onCancel, true)
      // 阻止默认的文本选中——拖到一半整页高亮很难看。
      event.preventDefault()
    })
  }

  /**
   * 调后端的探测接口（模型清单 / 单模型测试）。
   *
   * 走 originalFetch 而不是 window.fetch：上面那个补丁只拦 POST /api/chat，
   * 这里本来也不会被绕进去，但显式用原生的更稳妥。
   * 请求体里带的是卡片里「当前」的地址和密钥，可以是还没保存的——后端的
   * ModelProbeRequest 就是为「刚粘上地址就想看看有哪些模型」设计的。
   */
  async function probeBackend(path, payload) {
    const response = await originalFetch(`/api/settings/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const data = await response.json()
        if (data?.detail) detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
      } catch { /* 上游返回的不是 JSON，就只报状态码 */ }
      throw new Error(detail)
    }
    return response.json()
  }

  /** 探测用的凭据：优先用输入框里刚填的，没填就取已保存的那把。 */
  async function probeCredentials(api) {
    const apiKey = api.apiKey || (api.hasKey ? await desktop.revealApiKey(api.id) : '')
    return { base_url: api.baseUrl || '', api_key: apiKey || '' }
  }

  /** 能力标签下拉框，模型清单里每行一个。取值和 main.cjs 的 normalizeModelEntry 对齐。 */
  function capabilitySelect(value, onChange) {
    const select = document.createElement('select')
    select.className = 'enh-model-capability'
    for (const [option, label] of [['chat', '对话'], ['image', '绘画']]) {
      const node = document.createElement('option')
      node.value = option
      node.textContent = label
      select.appendChild(node)
    }
    select.value = value === 'image' ? 'image' : 'chat'
    select.addEventListener('change', () => onChange(select.value))
    return select
  }

  /**
   * 写模型行右侧那一小格状态文字。
   *
   * 上游报错时 message 可能是一整段原文（grok 那条 503 就有好几百字），
   * 直接塞进去会把行撑到屏幕外——CSS 那边已经用 minmax(0,1fr) + flex 收缩
   * 兜住了宽度，但把几百字硬塞进一个单行省略号的格子也没意义。所以这里再
   * 截一次：格子里放短的，完整原文进 title，鼠标悬停能看全。
   */
  function setStatus(node, text) {
    const full = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
    node.textContent = full.length > 60 ? `${full.slice(0, 60)}…` : full
    node.title = full
  }

  /**
   * 一个渠道自己的模型清单块：获取清单、手动增删、逐个测试。
   *
   * 只重绘自己这一小块 DOM，不惊动外面的 renderApiList——整表重绘会把地址、
   * 密钥输入框全部重建，正在填的内容和光标位置都会丢。
   */
  function buildModelBlock(api) {
    const block = document.createElement('div')
    block.className = 'field enh-model-block'
    const caption = document.createElement('label')
    caption.textContent = '模型清单'
    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = '只有这里列出的模型才会出现在聊天和绘画的模型选择器里。「获取模型清单」是问上游要一份清单，不产生费用；「测试」会真发一次极短的请求。'
    const rows = document.createElement('div')
    rows.className = 'enh-model-rows'
    const picker = document.createElement('div')
    picker.className = 'enh-model-picker'
    picker.hidden = true

    const fetchButton = document.createElement('button')
    fetchButton.type = 'button'
    fetchButton.className = 'btn-ghost'
    fetchButton.textContent = '获取模型清单'
    const manual = document.createElement('input')
    manual.type = 'text'
    manual.className = 'enh-model-manual'
    manual.placeholder = '手动填模型名，回车添加'
    const manualAdd = document.createElement('button')
    manualAdd.type = 'button'
    manualAdd.className = 'btn-ghost'
    manualAdd.textContent = '添加'
    const bar = document.createElement('div')
    bar.className = 'enh-model-bar'
    bar.append(fetchButton, manual, manualAdd)

    function hasModel(name, capability) {
      return (api.models || []).some((item) => item.name === name && item.capability === capability)
    }

    function addModel(name, capability = 'chat') {
      const trimmed = String(name || '').trim()
      if (!trimmed || hasModel(trimmed, capability)) return false
      if (!Array.isArray(api.models)) api.models = []
      api.models.push({ name: trimmed, capability })
      return true
    }

    function renderRows() {
      rows.replaceChildren()
      const models = Array.isArray(api.models) ? api.models : []
      if (!models.length) {
        const empty = document.createElement('div')
        empty.className = 'enh-model-empty'
        empty.textContent = '还没有模型。点「获取模型清单」，或手动填一个。'
        rows.appendChild(empty)
        return
      }
      models.forEach((model, index) => {
        const row = document.createElement('div')
        row.className = 'enh-model-row'
        const name = document.createElement('span')
        name.className = 'enh-model-name'
        name.textContent = model.name
        name.title = model.name
        const status = document.createElement('span')
        status.className = 'enh-model-status'
        const test = document.createElement('button')
        test.type = 'button'
        test.className = 'btn-ghost'
        test.textContent = '测试'
        test.addEventListener('click', async () => {
          test.disabled = true
          status.className = 'enh-model-status'
          setStatus(status, '测试中…')
          try {
            const credentials = await probeCredentials(api)
            const result = await probeBackend('model-test', { ...credentials, model: model.name })
            status.className = `enh-model-status ${result.ok ? 'ok' : 'bad'}`
            setStatus(status, result.message || (result.ok ? '可用' : '不可用'))
          } catch (error) {
            status.className = 'enh-model-status bad'
            setStatus(status, error?.message || String(error))
          } finally {
            test.disabled = false
          }
        })
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'btn-ghost'
        remove.textContent = '移除'
        remove.addEventListener('click', () => {
          api.models.splice(index, 1)
          renderRows()
        })
        const capability = capabilitySelect(model.capability, (value) => { model.capability = value })
        row.append(name, capability, test, remove, status)
        rows.appendChild(row)
      })
    }

    function renderPicker(names) {
      picker.replaceChildren()
      picker.hidden = false
      const head = document.createElement('div')
      head.className = 'enh-model-picker-head'
      const title = document.createElement('span')
      title.textContent = `上游返回 ${names.length} 个模型，勾选要添加的：`
      const filter = document.createElement('input')
      filter.type = 'search'
      filter.className = 'enh-model-filter'
      filter.placeholder = '筛选'
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'btn-ghost'
      close.textContent = '收起'
      close.addEventListener('click', () => { picker.hidden = true })
      head.append(title, filter, close)

      const options = document.createElement('div')
      options.className = 'enh-model-options'
      const boxes = names.map((name) => {
        const label = document.createElement('label')
        label.className = 'enh-model-option'
        const box = document.createElement('input')
        box.type = 'checkbox'
        // 已经在清单里的默认勾上并锁住，避免重复添加。
        box.checked = hasModel(name, 'chat')
        box.disabled = box.checked
        label.append(box, document.createTextNode(name))
        options.appendChild(label)
        return { name, box, label }
      })
      filter.addEventListener('input', () => {
        const keyword = filter.value.trim().toLowerCase()
        for (const item of boxes) {
          item.label.hidden = Boolean(keyword) && !item.name.toLowerCase().includes(keyword)
        }
      })

      const capability = capabilitySelect('chat', () => {})
      const confirm = document.createElement('button')
      confirm.type = 'button'
      confirm.className = 'btn-ghost'
      confirm.textContent = '添加选中'
      confirm.addEventListener('click', () => {
        let added = 0
        for (const item of boxes) {
          if (item.box.disabled || !item.box.checked) continue
          if (addModel(item.name, capability.value)) added += 1
          item.box.disabled = true
        }
        renderRows()
        showToast(added ? `已添加 ${added} 个模型` : '没有勾选新的模型')
      })
      const foot = document.createElement('div')
      foot.className = 'enh-model-picker-foot'
      const capLabel = document.createElement('span')
      capLabel.textContent = '添加为：'
      foot.append(capLabel, capability, confirm)
      picker.append(head, options, foot)
    }

    fetchButton.addEventListener('click', async () => {
      fetchButton.disabled = true
      showWaiting('model-list', '正在获取模型清单，请稍候…')
      try {
        const result = await probeBackend('model-list', await probeCredentials(api))
        if (!result.ok || !result.models?.length) {
          showToast(result.message || '没有拿到模型清单')
          return
        }
        renderPicker(result.models)
        showToast(result.message || `上游提供 ${result.models.length} 个模型`)
      } catch (error) {
        showToast(`获取模型清单失败：${error?.message || error}`)
      } finally {
        hideWaiting('model-list')
        fetchButton.disabled = false
      }
    })

    function submitManual() {
      if (addModel(manual.value)) {
        manual.value = ''
        renderRows()
      } else if (manual.value.trim()) {
        showToast('这个模型已经在清单里了')
      }
    }
    manualAdd.addEventListener('click', submitManual)
    manual.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      // 设置弹窗里回车会顺手触发「保存」，这里必须掐住。
      event.preventDefault()
      submitManual()
    })

    renderRows()
    block.append(caption, hint, bar, rows, picker)
    return block
  }

  function settingsHost(body) {
    // 新版设置面板把「多 API」单独分了一栏，注入到那个占位容器里；
    // 旧版没有占位容器，退回到「聊天」标题后面。
    const slot = body.querySelector('.enh-settings-slot')
    if (slot) return { slot, heading: null }
    const heading = [...body.querySelectorAll('.settings-section-title')]
      .find((item) => item.textContent.trim() === '聊天')
    return heading ? { slot: null, heading } : null
  }

  async function injectSettings(body) {
    if (!body.isConnected || body.querySelector('.enh-settings-section')) return
    // 项目编辑这类弹窗也有 .modal-body，先确认这是设置面板再去读配置。
    if (!settingsHost(body)) return
    showWaiting('enhancement-settings-load', '正在读取 API 设置，请稍候…')
    let data
    try {
      data = await desktop.getEnhancements()
    } finally {
      hideWaiting('enhancement-settings-load')
    }
    if (!body.isConnected || body.querySelector('.enh-settings-section')) return
    const draft = {
      // models 要单独拷一层：模型清单块是就地改 entry 的 capability 的，
      // 浅拷贝会让草稿和 data 共用同一批对象。
      apiList: data.apiList.map((item) => ({
        ...item,
        apiKey: '',
        models: (Array.isArray(item.models) ? item.models : []).map((model) => ({ ...model })),
      })),
      apiTimeoutSeconds: data.apiTimeoutSeconds,
      deepseekUrl: data.deepseekUrl,
      updateProxy: data.updateProxy || '',
      prompts: { ...data.prompts },
    }

    // 「显示」按钮会把已存的 Key 回填进输入框，那不是用户的改动。这里记下
    // 回填值，比对时归一成空串，免得点一下「显示」就被判成「有未保存的改动」。
    const revealedKeys = new Map()
    const snapshot = () => JSON.stringify({
      ...draft,
      apiList: draft.apiList.map((api) => ({
        ...api,
        apiKey: api.apiKey === (revealedKeys.get(api.id) || '') ? '' : api.apiKey,
      })),
    })
    let baseline = snapshot()
    let dirty = false

    /**
     * 重新比对一次草稿，状态变了就派事件通知设置弹窗。
     *
     * 这一栏是原生 DOM 注入的，改动落在上面那个闭包里的 draft，React 的
     * settings 从头到尾不变——所以设置弹窗自己的 isDirty() 永远看不到它，
     * 用户改完多 API 直接关窗会被静默丢弃。这条通道就是补这个洞的。
     */
    function syncDirty() {
      const next = snapshot() !== baseline
      if (next === dirty) return
      dirty = next
      window.dispatchEvent(new CustomEvent('chatbot-settings-extras-dirty', { detail: dirty }))
    }

    const host = settingsHost(body)
    if (!host) return
    // 单 API 的旧输入框由多 API 列表接管，隐藏掉以免两处冲突。
    const legacyFields = [...body.querySelectorAll('.field-legacy-api')]
    if (!legacyFields.length && host.heading) {
      let cursor = host.heading.nextElementSibling
      while (cursor && legacyFields.length < 2) {
        if (cursor.classList?.contains('field')) legacyFields.push(cursor)
        cursor = cursor.nextElementSibling
      }
    }
    for (const field of legacyFields) field.classList.add('enh-hidden-legacy-api')

    const section = document.createElement('section')
    section.className = 'enh-settings-section'
    const heading = document.createElement('h3')
    heading.className = 'settings-section-title'
    heading.textContent = 'API 渠道与 DeepSeek'
    const description = document.createElement('div')
    description.className = 'hint enh-section-hint'
    description.textContent = '每个渠道各自维护一份模型清单，选中哪个渠道的模型就只调那个渠道，不会自动换别家。卡片默认折叠，点右侧的 ▾ 展开填写地址、密钥和模型，按住左侧的 ⋮⋮ 手柄可拖动调整顺序。API Key 以明文保存在本地配置文件中，以便多台电脑间同步。'
    const list = document.createElement('div')
    list.className = 'enh-api-list'
    // 拖动排序只在这里挂一次：列表重绘换的是子节点，容器本身一直是同一个。
    makeSortable(list, {
      handleSelector: '.enh-drag-handle',
      onReorder: (from, to) => {
        const [moved] = draft.apiList.splice(from, 1)
        draft.apiList.splice(to, 0, moved)
        renderApiListKeepingScroll()
      },
    })

    // 展开着的卡片 id。刻意只存在这个闭包里：每次打开设置页 injectSettings
    // 都会重跑一遍，于是一律从「全部折叠」开始，不做持久化。
    const expandedIds = new Set()

    /**
     * 重绘列表，并让滚动位置**保持不动**。
     *
     * renderApiList() 是整表 replaceChildren：子节点一清空，滚动容器的
     * scrollHeight 瞬间归零，浏览器会把 scrollTop 夹到 0。等新节点补回来，
     * 滚动位置已经丢了——表现就是点一下 ▾ 展开，整个设置弹窗弹回最顶上，
     * 卡片多的时候每展开一个都要重新滚下来找。
     *
     * 滚的不是 .enh-api-list 自己而是它的某个祖先（当前是设置弹窗的
     * .modal-body），所以用 scrollableAncestor() 运行时找，不写死类名。
     * 记录/还原都在同一个同步任务里做，中间不会被绘制打断，所以不会闪。
     */
    function renderApiListKeepingScroll() {
      const scroller = scrollableAncestor(list)
      const top = scroller ? scroller.scrollTop : 0
      renderApiList()
      // 卡片收起后总高度可能变矮，浏览器会自己夹到新的最大值，这里不用再判断。
      if (scroller) scroller.scrollTop = top
      // 添加、删除、拖动排序都走这里，而它们不产生 input/change 事件，
      // 光靠 section 上那几个监听会漏掉。
      syncDirty()
    }

    function renderApiList() {
      list.replaceChildren()
      draft.apiList.forEach((api, index) => {
        const expanded = expandedIds.has(api.id)
        const card = document.createElement('div')
        card.className = expanded ? 'enh-api-card expanded' : 'enh-api-card'
        card.dataset.sortIndex = String(index)
        const header = document.createElement('div')
        header.className = 'enh-api-header'
        const handle = document.createElement('span')
        handle.className = 'enh-drag-handle'
        handle.textContent = '⋮⋮'
        handle.title = '拖动排序'
        // 名称从原来的独立字段挪到标题行：折叠状态下只剩手柄、名字和箭头，
        // 一屏能看下十几个 API，找起来比一路滚动快得多。
        const name = document.createElement('input')
        name.className = 'enh-api-name'
        name.value = api.name || ''
        name.placeholder = `API ${index + 1}`
        name.addEventListener('input', () => { api.name = name.value })
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'btn-ghost enh-api-toggle'
        toggle.textContent = expanded ? '▴' : '▾'
        toggle.title = expanded ? '收起' : '展开'
        toggle.addEventListener('click', () => {
          if (expanded) expandedIds.delete(api.id)
          else expandedIds.add(api.id)
          renderApiListKeepingScroll()
        })
        header.append(handle, name, toggle)
        card.append(header)

        if (!expanded) {
          list.appendChild(card)
          return
        }

        const enabledLabel = document.createElement('label')
        enabledLabel.className = 'enh-enabled'
        const enabled = document.createElement('input')
        enabled.type = 'checkbox'
        enabled.checked = api.enabled !== false
        enabled.addEventListener('change', () => { api.enabled = enabled.checked })
        enabledLabel.append(enabled, document.createTextNode('启用'))
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'btn-ghost enh-remove-api'
        remove.textContent = '删除'
        remove.addEventListener('click', () => {
          expandedIds.delete(api.id)
          draft.apiList.splice(index, 1)
          renderApiListKeepingScroll()
        })
        const actions = document.createElement('div')
        actions.className = 'enh-api-actions'
        actions.append(enabledLabel, remove)

        const urlField = createInput('Base URL', api.baseUrl, (value) => { api.baseUrl = value }, { placeholder: 'https://api.example.com/v1' })
        const keyRow = document.createElement('div')
        keyRow.className = 'field enh-key-field'
        const keyLabel = document.createElement('label')
        keyLabel.textContent = 'API Key'
        const keyControls = document.createElement('div')
        keyControls.className = 'enh-key-controls'
        const key = document.createElement('input')
        key.type = 'password'
        key.placeholder = api.hasKey ? '已保存；留空表示不修改' : 'sk-…'
        // 折叠再展开会重建这个输入框，把已经改过还没保存的值填回去，
        // 否则用户填了 Key、收起卡片、再展开就白填了。
        key.value = api.apiKey || ''
        key.addEventListener('input', () => { api.apiKey = key.value })
        const reveal = document.createElement('button')
        reveal.type = 'button'
        reveal.className = 'btn-ghost'
        reveal.textContent = '显示'
        reveal.disabled = !api.hasKey
        reveal.addEventListener('click', async () => {
          if (key.type === 'text') {
            key.type = 'password'
            reveal.textContent = '显示'
            return
          }
          if (!key.value) {
            showWaiting('api-key-reveal', '正在读取 API Key，请稍候…')
            try {
              key.value = await desktop.revealApiKey(api.id)
            } finally {
              hideWaiting('api-key-reveal')
            }
            // 回填的是已存的值，登记下来，别把它算成用户的改动。
            revealedKeys.set(api.id, key.value)
          }
          api.apiKey = key.value
          key.type = 'text'
          reveal.textContent = '隐藏'
          syncDirty()
        })
        keyControls.append(key, reveal)
        keyRow.append(keyLabel, keyControls)
        card.append(actions, urlField.field, keyRow, buildModelBlock(api))
        list.appendChild(card)
      })
      if (!draft.apiList.length) {
        const empty = document.createElement('div')
        empty.className = 'enh-api-empty'
        empty.textContent = '尚未添加 API。'
        list.appendChild(empty)
      }
    }

    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'btn-ghost enh-add-api'
    add.textContent = '＋ 添加 API'
    add.addEventListener('click', () => {
      const id = crypto.randomUUID()
      draft.apiList.push({
        id,
        name: `API ${draft.apiList.length + 1}`,
        baseUrl: '',
        apiKey: '',
        hasKey: false,
        enabled: true,
        models: [],
      })
      // 新加的直接展开：刚点完「添加」就是要填地址和密钥，
      // 折叠着只会多一次点击。
      expandedIds.add(id)
      renderApiListKeepingScroll()
      // 「添加 API」按钮在列表下方，用户本来就停在底部；保持滚动位置之后
      // 再把新卡片带进视野，免得它正好落在按钮下面看不见。
      list.lastElementChild?.scrollIntoView({ block: 'nearest' })
    })

    const timeout = createInput('单个 API 无响应超时（秒）', draft.apiTimeoutSeconds, (value) => {
      draft.apiTimeoutSeconds = Number(value)
    }, { type: 'number' })
    timeout.input.min = '3'
    timeout.input.max = '120'
    const deepseek = createInput('DeepSeek 网页地址', draft.deepseekUrl, (value) => {
      draft.deepseekUrl = value
    }, { placeholder: 'https://chat.deepseek.com/' })
    const updateProxy = createInput('更新代理（可选）', draft.updateProxy, (value) => {
      draft.updateProxy = value
    }, { placeholder: '127.0.0.1:7890，留空则自动探测' })
    const updateProxyHint = document.createElement('div')
    updateProxyHint.className = 'hint enh-section-hint'
    updateProxyHint.textContent = '仅用于检查和下载更新：直连失败时会依次尝试 DoH 解析、镜像站，最后才用这里的代理。代理设置只在更新请求中生效，不会改动系统网络配置。'

    const promptHeading = document.createElement('h4')
    promptHeading.className = 'enh-prompt-heading'
    promptHeading.textContent = '网页操作提示词模板（使用 {content} 插入内容）'
    const promptFields = [
      ['询问', 'ask'],
      ['解释代码', 'explainCode'],
      ['查找问题', 'findIssues'],
      ['优化代码', 'optimizeCode'],
    ].map(([label, key]) => createInput(label, draft.prompts[key], (value) => {
      draft.prompts[key] = value
    }, { multiline: true, rows: 2 }))

    renderApiList()
    section.append(
      heading, description, list, add, timeout.field, deepseek.field,
      updateProxy.field, updateProxyHint, promptHeading,
    )
    for (const item of promptFields) section.appendChild(item.field)
    if (host.slot) host.slot.replaceChildren(section)
    else host.heading.insertAdjacentElement('afterend', section)

    // 旧写法是在这里劫持底部「保存」按钮的 click。那样只有点按钮那一条路
    // 存得上多 API：未保存确认框里的「保存」走的是设置弹窗自己的 save()，
    // 绕过按钮，改动照样丢。改成把保存动作交出去，由 save() 统一调。

    // 改动状态和保存动作都挂到这个全局上，供设置弹窗读取。contextBridge
    // 暴露的 chatbotDesktop 是冻结的，加不了字段，所以另开一个。
    window.chatbotSettingsExtras = {
      isDirty: () => section.isConnected && dirty,
      save: async () => {
        if (!section.isConnected) return
        showWaiting('enhancement-settings-save', '正在保存 API 设置，请稍候…')
        try {
          await desktop.saveEnhancements(draft)
          baseline = snapshot()
          syncDirty()
        } finally {
          hideWaiting('enhancement-settings-save')
        }
      },
    }
    // 名称、地址、超时这些走 input；启用勾选和能力下拉走 change；模型清单的
    // 增删是按钮，只能靠 click 兜住（冒泡到这里时目标的处理器已经改完 draft）。
    for (const type of ['input', 'change', 'click']) section.addEventListener(type, syncDirty)
    // 每次重开设置都会重跑 injectSettings，先把上一轮的残留状态清零。
    window.dispatchEvent(new CustomEvent('chatbot-settings-extras-dirty', { detail: false }))
  }

  const settingsObserver = new MutationObserver(() => {
    const body = document.querySelector('.modal .modal-body')
    if (body && !body.querySelector('.enh-settings-section')) injectSettings(body).catch(console.error)
  })
  settingsObserver.observe(document.documentElement, { childList: true, subtree: true })
})()
