import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

/**
 * 指针拖动排序。
 *
 * 为什么不用 HTML5 drag&drop：它的拖影是浏览器截的静态位图，改不了大小和透明度，
 * 也没法让下面的项目实时让位。要「缩小半透明跟随鼠标 + 原位留占位框 + 相邻项被
 * 顶开」这套效果，只能自己接指针事件。
 *
 * 桌面端注入脚本里有一份等价实现（`source/desktop/page-enhancements.js` 的
 * `makeSortable`）。那边跑在 React 之外、只有 vanilla DOM，共用不了这个 hook，
 * 改动效果时**两处要一起改**。
 *
 * 用法：
 *
 * ```tsx
 * const sortable = useSortableList(items.length, (from, to) => reorder(from, to))
 * <div ref={sortable.containerRef}>
 *   {items.map((item, i) => (
 *     <div key={item} {...sortable.itemProps(i)}>…</div>
 *   ))}
 * </div>
 * ```
 *
 * `itemProps` 给出的 className 里带着三种状态，样式见 shared-components.css：
 * `.sortable-item` / `.sortable-placeholder` / `.sortable-shifting`。
 */

/** 指针移动超过这么多像素才算拖动，避免「想点一下」被判成拖。 */
const DRAG_THRESHOLD = 4

interface Snapshot {
  node: HTMLElement
  baseTop: number
  height: number
}

export interface SortableOptions {
  /**
   * 只有点在匹配这个选择器的元素（或它的子元素）上才开始拖动。
   * 列表项里有输入框、勾选框、按钮时必须给——否则整项都是拖动区，
   * 点进输入框会被 preventDefault 掉，光标进不去。
   */
  handleSelector?: string
}

export function useSortableList(
  count: number,
  onReorder: (from: number, to: number) => void,
  options: SortableOptions = {},
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLElement | null>(null)
  const layoutRef = useRef<Snapshot[]>([])
  // 用 ref 存实时值、用 state 存渲染需要的值：
  // 拖动过程中每帧都在变，全走 state 会让整个菜单重渲染。
  const fromRef = useRef(-1)
  const toRef = useRef(-1)
  // 刚刚真的拖动过。pointerup 之后浏览器还会补一个 click，
  // 不挡掉的话「拖完松手」会顺带触发列表项的点击（选中模型、关掉菜单）。
  const draggedRef = useRef(false)
  const [dragging, setDragging] = useState(-1)
  const [target, setTarget] = useState(-1)

  const onReorderRef = useRef(onReorder)
  onReorderRef.current = onReorder
  // 同样用 ref：选择器是配置项，不该进 start 的依赖里让回调反复重建。
  const handleRef = useRef(options.handleSelector)
  handleRef.current = options.handleSelector

  // 组件卸载时兜底清掉 ghost：菜单可能在拖动中途被关掉，
  // 那样 body 上会留一个删不掉的浮层。
  useEffect(() => () => {
    ghostRef.current?.remove()
    ghostRef.current = null
    document.body.classList.remove('sortable-dragging')
  }, [])

  const start = useCallback((index: number, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || count < 2) return
    // 指定了拖动把手就先看有没有点在把手上。这一步必须在 preventDefault 之前，
    // 否则卡片里的输入框永远拿不到焦点。
    const handle = handleRef.current
    if (handle && !(event.target as HTMLElement | null)?.closest?.(handle)) return
    const source = event.currentTarget
    const startX = event.clientX
    const startY = event.clientY
    let started = false
    let offsetX = 0
    let offsetY = 0
    let shift = 0

    const begin = () => {
      const container = containerRef.current
      if (!container) return
      started = true
      const rect = source.getBoundingClientRect()
      const gap = parseFloat(getComputedStyle(container).rowGap || '0') || 0
      shift = rect.height + gap
      layoutRef.current = [...container.querySelectorAll<HTMLElement>('[data-sort-index]')]
        .map((node) => {
          const box = node.getBoundingClientRect()
          return { node, baseTop: box.top, height: box.height }
        })

      // 克隆一份跟随指针，原节点留在原位当占位框。
      // 挂在 body 下而不是菜单里：菜单有 overflow 裁剪，拖出边界就看不见了。
      const ghost = source.cloneNode(true) as HTMLElement
      ghost.classList.add('sortable-ghost')
      ghost.style.width = `${rect.width}px`
      ghost.style.height = `${rect.height}px`
      document.body.appendChild(ghost)
      ghostRef.current = ghost
      offsetX = startX - rect.left
      offsetY = startY - rect.top
      moveGhost(startX, startY)

      fromRef.current = index
      toRef.current = index
      setDragging(index)
      setTarget(index)
      document.body.classList.add('sortable-dragging')
    }

    const moveGhost = (clientX: number, clientY: number) => {
      const ghost = ghostRef.current
      if (!ghost) return
      // 缩到 0.94，锚点在左上角，视觉上像是「抓起来了一点」。
      ghost.style.transform = `translate(${clientX - offsetX}px, ${clientY - offsetY}px) scale(.94)`
    }

    /**
     * 按被拖项的**中心**跟其它项的中线比，算出应该插到第几位。
     *
     * 中线用的是**原始位置**（`baseTop`，进入拖动时快照的），不是实时的
     * `getBoundingClientRect()`——后者已经被让位的 transform 改过了，拿它算会来回抖。
     */
    const updateOrder = (clientY: number) => {
      const layout = layoutRef.current
      const from = fromRef.current
      if (from < 0 || !layout[from]) return
      const draggedCenter = clientY - offsetY + layout[from].height / 2
      let next = from
      for (let i = 0; i < layout.length; i += 1) {
        if (i === from) continue
        const middle = layout[i].baseTop + layout[i].height / 2
        if (i < from && draggedCenter < middle) next = Math.min(next, i)
        if (i > from && draggedCenter > middle) next = Math.max(next, i)
      }
      if (next === toRef.current) return
      toRef.current = next
      setTarget(next)
      for (let i = 0; i < layout.length; i += 1) {
        if (i === from) continue
        // 往上拖：区间 [to, from) 里的项整体下移一格；
        // 往下拖：区间 (from, to] 里的项整体上移一格。
        let delta = 0
        if (next < from && i >= next && i < from) delta = shift
        if (next > from && i > from && i <= next) delta = -shift
        layout[i].node.style.transform = delta ? `translateY(${delta}px)` : ''
      }
    }

    const onMove = (moveEvent: PointerEvent) => {
      if (!started) {
        const moved = Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY)
        if (moved < DRAG_THRESHOLD) return
        begin()
        if (!started) return
      }
      moveEvent.preventDefault()
      moveGhost(moveEvent.clientX, moveEvent.clientY)
      updateOrder(moveEvent.clientY)
    }

    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
      if (!started) return
      ghostRef.current?.remove()
      ghostRef.current = null
      draggedRef.current = true
      document.body.classList.remove('sortable-dragging')
      for (const item of layoutRef.current) item.node.style.transform = ''
      layoutRef.current = []
      const from = fromRef.current
      const to = toRef.current
      fromRef.current = -1
      toRef.current = -1
      setDragging(-1)
      setTarget(-1)
      if (commit && from >= 0 && to >= 0 && from !== to) onReorderRef.current(from, to)
    }

    const onUp = () => finish(true)
    const onCancel = () => finish(false)

    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    // 阻止默认的文本选中——拖到一半整片高亮很难看。
    event.preventDefault()
  }, [count])

  const itemProps = useCallback((index: number) => ({
    'data-sort-index': index,
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => start(index, event),
    // 拖动结束后浏览器补的那次 click 要挡掉，否则松手会顺带选中这一项。
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
      if (!draggedRef.current) return
      draggedRef.current = false
      event.preventDefault()
      event.stopPropagation()
    },
    className: [
      'sortable-item',
      index === dragging ? 'sortable-placeholder' : '',
      // 被拖的那项自己不加过渡，否则松手回位时会多滑一下。
      dragging >= 0 && index !== dragging ? 'sortable-shifting' : '',
    ].filter(Boolean).join(' '),
  }), [start, dragging])

  return { containerRef, itemProps, dragging, target }
}
