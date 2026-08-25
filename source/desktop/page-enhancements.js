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

  async function runChatFailover(controller, input, init, body, model, plan) {
    const failures = []
    for (let index = 0; index < plan.attempts.length; index += 1) {
      const api = plan.attempts[index]
      const hasNext = index < plan.attempts.length - 1
      let token = null
      let reader = null
      let startEvent = null
      let partialReceived = false
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

        if (!failureMessage && !partialReceived) {
          window.dispatchEvent(new CustomEvent('chatbot-api-match-complete'))
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
            if (event.type === 'start') {
              startEvent = event
              controller.enqueue(sseEvent(event))
            } else if (event.type === 'error') {
              failureMessage = event.message || '请求失败'
            } else if (event.type === 'content' || event.type === 'thinking') {
              partialReceived = true
              controller.enqueue(sseEvent(event))
            } else if (event.type === 'done') {
              sawDone = true
              controller.enqueue(sseEvent(event))
            } else if (!failureMessage) {
              controller.enqueue(sseEvent(event))
            }
          }
        }
        if (!failureMessage && !sawDone) failureMessage = 'API 响应意外中断'
        if (!failureMessage) {
          await desktop.markApiSuccess({ model, apiId: api.id })
          controller.close()
          return
        }
      } catch (error) {
        if (init.signal?.aborted || error?.name === 'AbortError') {
          try { await reader?.cancel() } catch {}
          window.dispatchEvent(new CustomEvent('chatbot-api-match-complete'))
          controller.close()
          return
        }
        failureMessage = error?.message || String(error)
      } finally {
        init.signal?.removeEventListener('abort', abortFromCaller)
        if (token) await desktop.endApiAttempt(token).catch(() => {})
      }

      failures.push({ api: api.name, message: failureMessage })
      if (hasNext) {
        window.dispatchEvent(new CustomEvent('chatbot-api-match-waiting', {
          detail: { message: '当前 API 不可用，正在尝试其他 API，请稍候…' },
        }))
        if (startEvent) {
          await desktop.cleanupApiAttempt({
            conversationId: body.conversation_id,
            userMessageId: startEvent.user_message?.id || null,
            assistantMessageId: startEvent.assistant_message_id || null,
            parentId: startEvent.user_message?.parent_id || null,
            regenerate: Boolean(body.regenerate_from),
          }).catch(() => {})
        }
        if (partialReceived) controller.enqueue(sseEvent({ type: 'reset' }))
      }
    }

    const summary = failures.map((item) => `${item.api}：${item.message}`).join('\n') || '没有可用的 API'
    window.dispatchEvent(new CustomEvent('chatbot-api-match-complete'))
    window.dispatchEvent(new CustomEvent('chatbot-api-failures', { detail: { failures, summary } }))
    controller.enqueue(sseEvent({ type: 'error', message: `所有 API 均不可用\n${summary}` }))
    controller.close()
  }

  window.fetch = async function enhancedFetch(input, init = {}) {
    const requestUrl = typeof input === 'string' ? input : input?.url || ''
    let parsed
    try { parsed = new URL(requestUrl, location.href) } catch { return originalFetch(input, init) }
    const method = String(init.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase()
    if (method !== 'POST' || parsed.pathname !== '/api/chat') return originalFetch(input, init)

    let body
    try { body = JSON.parse(init.body) } catch { return originalFetch(input, init) }
    const model = String(body.model || '')
    let plan = null
    try {
      plan = await desktop.getApiPlan(model)
      if (plan?.attempts?.length && !plan.matched) {
        window.dispatchEvent(new CustomEvent('chatbot-api-match-waiting', {
          detail: { message: '正在为该模型选择适合的 API，请稍候…' },
        }))
      }
    } catch (error) {
      return apiErrorResponse(error?.message || String(error))
    }
    const enhancedInit = init
    if (!plan.attempts.length) {
      window.dispatchEvent(new CustomEvent('chatbot-api-match-complete'))
      setTimeout(() => window.dispatchEvent(new CustomEvent('chatbot-api-failures', {
        detail: { failures: [], summary: '没有已启用的 API，请先打开设置添加 API。' },
      })), 0)
      return apiErrorResponse('没有已启用的 API，请先打开设置添加 API。')
    }
    const stream = new ReadableStream({
      start(controller) {
        runChatFailover(controller, input, enhancedInit, body, model, plan).catch((error) => {
          window.dispatchEvent(new CustomEvent('chatbot-api-match-complete'))
          controller.enqueue(sseEvent({ type: 'error', message: error?.message || String(error) }))
          controller.close()
        })
      },
    })
    const response = new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    Object.defineProperty(response, 'aiChatbotFailover', { value: true })
    return response
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

  window.addEventListener('chatbot-api-match-waiting', (event) => {
    showWaiting('api-match', event.detail?.message || '正在选择适合的 API，请稍候…')
  })
  window.addEventListener('chatbot-api-match-complete', () => hideWaiting('api-match'))

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
    title.textContent = '所有 API 均不可用'
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

  // 监听器挂在 document 上而不是卡片上：drop 之后列表会整体重绘，
  // 被拖的那张卡片已经从 DOM 里没了，它的 dragend 不一定还会触发。
  function onDocumentDragOver(event) {
    updateDragScroll(event.clientY)
  }

  function beginDragScroll(node) {
    dragScroll.target = scrollableAncestor(node)
    document.addEventListener('dragover', onDocumentDragOver, true)
  }

  function stopDragScroll() {
    document.removeEventListener('dragover', onDocumentDragOver, true)
    if (dragScroll.frame) cancelAnimationFrame(dragScroll.frame)
    dragScroll.frame = 0
    dragScroll.target = null
    dragScroll.speed = 0
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
      apiList: data.apiList.map((item) => ({ ...item, apiKey: '' })),
      apiTimeoutSeconds: data.apiTimeoutSeconds,
      deepseekUrl: data.deepseekUrl,
      prompts: { ...data.prompts },
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
    heading.textContent = '多 API 与 DeepSeek'
    const description = document.createElement('div')
    description.className = 'hint enh-section-hint'
    description.textContent = '按列表顺序为模型查找可用 API；按住卡片左上角的 ⋮⋮ 手柄可拖动调整顺序。API Key 以明文保存在本地配置文件中，以便多台电脑间同步。'
    const list = document.createElement('div')
    list.className = 'enh-api-list'

    function renderApiList() {
      list.replaceChildren()
      draft.apiList.forEach((api, index) => {
        const card = document.createElement('div')
        card.className = 'enh-api-card'
        // 默认不可拖动，只有在左上角手柄上按下鼠标时才临时开启，
        // 否则卡片内的输入框无法选中文本。
        card.draggable = false
        card.dataset.index = String(index)
        card.addEventListener('dragstart', (event) => {
          if (!card.draggable) {
            event.preventDefault()
            return
          }
          event.dataTransfer.setData('text/plain', String(index))
          event.dataTransfer.effectAllowed = 'move'
          beginDragScroll(list)
        })
        card.addEventListener('dragend', () => {
          card.draggable = false
          stopDragScroll()
        })
        card.addEventListener('dragover', (event) => event.preventDefault())
        card.addEventListener('drop', (event) => {
          event.preventDefault()
          stopDragScroll()
          const from = Number(event.dataTransfer.getData('text/plain'))
          const to = index
          if (!Number.isInteger(from) || from === to) return
          const [moved] = draft.apiList.splice(from, 1)
          draft.apiList.splice(to, 0, moved)
          renderApiList()
        })
        const header = document.createElement('div')
        header.className = 'enh-api-header'
        const handle = document.createElement('span')
        handle.className = 'enh-drag-handle'
        handle.textContent = '⋮⋮'
        handle.title = '拖动排序'
        handle.addEventListener('mousedown', () => {
          card.draggable = true
          // 松开鼠标即解除武装：无论是否真的发生了拖拽，
          // 都不能让卡片保持可拖动状态，否则输入框又会被劫持。
          const disarm = () => {
            card.draggable = false
            window.removeEventListener('mouseup', disarm, true)
          }
          window.addEventListener('mouseup', disarm, true)
        })
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
        remove.addEventListener('click', () => { draft.apiList.splice(index, 1); renderApiList() })
        header.append(handle, enabledLabel, remove)

        const nameField = createInput('名称', api.name, (value) => { api.name = value }, { placeholder: `API ${index + 1}` })
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
          }
          api.apiKey = key.value
          key.type = 'text'
          reveal.textContent = '隐藏'
        })
        keyControls.append(key, reveal)
        keyRow.append(keyLabel, keyControls)
        card.append(header, nameField.field, urlField.field, keyRow)
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
      draft.apiList.push({
        id: crypto.randomUUID(),
        name: `API ${draft.apiList.length + 1}`,
        baseUrl: '',
        apiKey: '',
        hasKey: false,
        enabled: true,
      })
      renderApiList()
    })

    const timeout = createInput('单个 API 无响应超时（秒）', draft.apiTimeoutSeconds, (value) => {
      draft.apiTimeoutSeconds = Number(value)
    }, { type: 'number' })
    timeout.input.min = '3'
    timeout.input.max = '120'
    const deepseek = createInput('DeepSeek 网页地址', draft.deepseekUrl, (value) => {
      draft.deepseekUrl = value
    }, { placeholder: 'https://chat.deepseek.com/' })

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

    const matches = document.createElement('div')
    matches.className = 'enh-model-matches hint'
    const matchEntries = Object.entries(data.modelMatches || {})
    matches.textContent = matchEntries.length
      ? `已记住：${matchEntries.map(([model, item]) => `${model} → ${item.apiName}`).join('；')}`
      : '当前还没有已记住的模型/API 匹配。'

    renderApiList()
    section.append(heading, description, list, add, timeout.field, deepseek.field, promptHeading)
    for (const item of promptFields) section.appendChild(item.field)
    section.appendChild(matches)
    if (host.slot) host.slot.replaceChildren(section)
    else host.heading.insertAdjacentElement('afterend', section)

    const saveButton = [...document.querySelectorAll('.modal-footer .btn-primary')]
      .find((button) => button.textContent.includes('保存'))
    if (saveButton && !saveButton.dataset.enhancedSave) {
      saveButton.dataset.enhancedSave = 'true'
      const enhancedSaveHandler = async (event) => {
        event.preventDefault()
        event.stopImmediatePropagation()
        showWaiting('enhancement-settings-save', '正在保存 API 设置，请稍候…')
        try {
          await desktop.saveEnhancements(draft)
          saveButton.removeEventListener('click', enhancedSaveHandler, true)
          saveButton.click()
        } catch (error) {
          alert(`保存多 API 设置失败：${error.message}`)
        } finally {
          hideWaiting('enhancement-settings-save')
        }
      }
      saveButton.addEventListener('click', enhancedSaveHandler, true)
    }
  }

  const settingsObserver = new MutationObserver(() => {
    const body = document.querySelector('.modal .modal-body')
    if (body && !body.querySelector('.enh-settings-section')) injectSettings(body).catch(console.error)
  })
  settingsObserver.observe(document.documentElement, { childList: true, subtree: true })
})()
