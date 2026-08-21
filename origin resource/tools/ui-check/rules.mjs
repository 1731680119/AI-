/**
 * B 档：几何断言规则。整段作为一个表达式注入页面执行，返回 JSON 字符串。
 *
 * 设计原则：每条规则都对应一个**真实踩过的坑**或一类肉眼容易漏掉的失效，
 * 不写「看起来应该检查一下」的泛泛规则——那只会制造噪音，让人开始无视报告。
 *
 * 规则来源见 CLAUDE.md §5：
 *   - popup-occluded  ← `.model-menu` 向上弹，被 52px 顶栏遮住
 *   - checkbox-stretched ← `.field input` 的 width:100% 没排除 checkbox，
 *                          勾选框被撑成整行，把右边的模型名挤成 0 宽
 *   - collapsed-text  ← 上面那个坑的**后果**，直接查「有文字但宽度为 0」
 */

export const RULES_SOURCE = String.raw`(() => {
  const out = []
  const vw = window.innerWidth
  const vh = window.innerHeight
  const TOL = 1

  const add = (rule, severity, el, message, extra) => {
    out.push({ rule, severity, selector: cssPath(el), message, ...(extra || {}) })
  }

  /** 生成一条够用的定位路径，报告里能一眼看出是哪个元素。 */
  function cssPath(el) {
    if (!el || el === document.documentElement) return 'html'
    const parts = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
      let part = node.tagName.toLowerCase()
      if (node.id) { parts.unshift(part + '#' + node.id); break }
      const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)
      if (cls.length) part += '.' + cls.slice(0, 3).join('.')
      const title = node.getAttribute('title')
      if (title) part += '[title="' + title + '"]'
      parts.unshift(part)
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  function styleVisible(el) {
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
  }

  /** 既没被 display/visibility 藏起来，也确实占了面积。 */
  function visible(el) {
    if (!styleVisible(el)) return false
    if (el.closest('[hidden]')) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  function rect(el) {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }

  function offscreen(r) {
    return r.right <= TOL || r.left >= vw - TOL || r.bottom <= TOL || r.top >= vh - TOL
  }

  /**
   * 祖先里是否有整个划出视口的容器。
   * 侧栏收起用的是 margin-left:-280px，整块滑出屏幕——抽屉式 UI 的常规做法，
   * 里面每个按钮都报一次「够不到」纯属噪音。容器级的状态在容器那层判断就够了。
   */
  function hasOffscreenAncestor(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (offscreen(p.getBoundingClientRect())) return true
    }
    return false
  }

  /** 元素是否躺在某个可滚动容器里——滚出可视区是正常的，不该报错。 */
  function hasScrollableAncestor(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p)
      const oy = s.overflowY, ox = s.overflowX
      if (oy === 'auto' || oy === 'scroll' || ox === 'auto' || ox === 'scroll') {
        if (p.scrollHeight > p.clientHeight + TOL || p.scrollWidth > p.clientWidth + TOL) return true
      }
    }
    return false
  }

  const all = Array.from(document.querySelectorAll('*'))

  // ── R1 弹出层必须完整落在视口内 ───────────────────────────────────────
  // 菜单跑出视口就等于点不到。这是「向上弹被顶栏吃掉」的第一道网。
  const POPUP_SELECTOR = '.model-menu, .modal, .enh-failure-card, .enh-panel'
  for (const el of document.querySelectorAll(POPUP_SELECTOR)) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    const over = []
    if (r.top < -TOL) over.push('上边超出 ' + Math.round(-r.top) + 'px')
    if (r.left < -TOL) over.push('左边超出 ' + Math.round(-r.left) + 'px')
    if (r.bottom > vh + TOL) over.push('下边超出 ' + Math.round(r.bottom - vh) + 'px')
    if (r.right > vw + TOL) over.push('右边超出 ' + Math.round(r.right - vw) + 'px')
    if (over.length) {
      add('popup-out-of-viewport', 'error', el,
        '弹出层超出视口：' + over.join('、'), { rect: rect(el) })
    }
  }

  // ── R2 弹出层不能被别的东西盖住 ──────────────────────────────────────
  // 命中测试比几何比较可靠：不用去猜顶栏多高、z-index 谁大。
  for (const el of document.querySelectorAll(POPUP_SELECTOR)) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    const probes = [
      ['中心', r.x + r.width / 2, r.y + r.height / 2],
      ['左上', r.x + 6, r.y + 6],
      ['右上', r.right - 6, r.y + 6],
      ['左下', r.x + 6, r.bottom - 6],
      ['右下', r.right - 6, r.bottom - 6],
    ]
    const blocked = []
    for (const [name, px, py] of probes) {
      if (px < 0 || py < 0 || px > vw || py > vh) { blocked.push(name + '（在视口外）'); continue }
      const hit = document.elementFromPoint(px, py)
      if (!hit) { blocked.push(name + '（无命中）'); continue }
      if (hit !== el && !el.contains(hit)) blocked.push(name + '（被 ' + cssPath(hit) + ' 盖住）')
    }
    if (blocked.length) {
      add('popup-occluded', 'error', el,
        '弹出层的这些位置点不到：' + blocked.join('；'), { rect: rect(el) })
    }
  }

  // ── R3 勾选框不能被拉宽 ──────────────────────────────────────────────
  // 对应 CLAUDE.md §5：.field input 的 width:100% 排除了 range/radio 却漏了 checkbox。
  for (const el of document.querySelectorAll('input[type="checkbox"]')) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 30) {
      add('checkbox-stretched', 'error', el,
        '勾选框被拉到 ' + Math.round(r.width) + 'px 宽（正常应 < 30px），'
        + '多半是某条 width:100% 的公共规则没排除 checkbox',
        { rect: rect(el) })
    }
  }

  // ── R4 有文字却被压成 0 宽/0 高 ──────────────────────────────────────
  // 上一条坑的实际表现：模型名 <span> 被挤到 0 宽，界面上凭空少一段字。
  for (const el of all) {
    // 收起的 <select> 里 <option> 天生没有盒子，这是浏览器行为不是布局问题。
    if (el.closest('select')) continue
    const text = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join('')
      .trim()
    if (!text) continue
    if (!styleVisible(el)) continue
    const parent = el.parentElement
    if (!parent || !visible(parent)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) {
      add('collapsed-text', 'error', el,
        '元素有文字「' + text.slice(0, 20) + '」但尺寸是 '
        + Math.round(r.width) + '×' + Math.round(r.height) + '，等于看不见',
        { rect: rect(el), text: text.slice(0, 60) })
    }
  }

  // ── R5 文字被容器裁掉且没有省略号 ────────────────────────────────────
  // 带 ellipsis 的截断是设计意图，不报；hidden 且没 ellipsis 才是真的丢字。
  for (const el of all) {
    if (!visible(el)) continue
    if (el.children.length > 0) continue
    if (!(el.textContent || '').trim()) continue
    const s = getComputedStyle(el)
    if (s.textOverflow === 'ellipsis') continue
    const ox = s.overflowX
    if (ox !== 'hidden' && ox !== 'clip') continue
    if (el.scrollWidth - el.clientWidth > TOL) {
      add('text-clipped', 'warn', el,
        '文字被裁掉约 ' + (el.scrollWidth - el.clientWidth) + 'px 且没有省略号',
        { rect: rect(el), text: (el.textContent || '').trim().slice(0, 60) })
    }
  }

  // ── R6 整页不该出现横向滚动 ──────────────────────────────────────────
  // 窗口一窄就冒出来的横条，是响应式坏掉最典型的信号。
  const docW = document.documentElement.scrollWidth
  if (docW > vw + TOL) {
    // 找出到底是谁把页面撑宽的，否则只报个总宽度没法查。
    const culprits = all
      .filter((el) => visible(el) && el.getBoundingClientRect().right > vw + TOL)
      .filter((el) => !hasScrollableAncestor(el))
      .slice(0, 5)
      .map((el) => cssPath(el) + '（右边到 ' + Math.round(el.getBoundingClientRect().right) + 'px）')
    out.push({
      rule: 'page-h-scroll',
      severity: 'error',
      selector: 'html',
      message: '整页出现横向滚动：文档宽 ' + docW + 'px > 视口 ' + vw + 'px'
        + (culprits.length ? '。可疑元素：' + culprits.join('；') : ''),
    })
  }

  // ── R7 可交互控件跑出视口 ────────────────────────────────────────────
  // 排掉两类正常情况：在滚动容器里的（列表滚下去很正常），
  // 以及整个容器被划出屏幕的（收起的侧栏这种抽屉式 UI）。
  // 剩下的才是「布局本身没安排好，控件被挤出去了」。
  for (const el of document.querySelectorAll('button, a[href], select, textarea, input:not([type="hidden"])')) {
    if (!visible(el)) continue
    if (hasScrollableAncestor(el)) continue
    if (hasOffscreenAncestor(el)) continue
    if (offscreen(el.getBoundingClientRect())) {
      add('control-offscreen', 'error', el,
        '可交互控件整个落在视口外，用户够不到', { rect: rect(el) })
    }
  }

  return JSON.stringify({
    viewport: { w: vw, h: vh },
    docWidth: docW,
    violations: out,
  })
})()`
