import { useCallback, useRef, useState } from 'react'
import type { DragEvent } from 'react'

/** 拖拽投放区的配置。 */
export interface FileDropOptions {
  /** 拿到投放的文件后做什么。数组已按 accept 过滤，且保证非空。 */
  onFiles: (files: File[]) => void
  /** 只收图片时传 'image'；不传则什么文件都收。 */
  accept?: 'image'
  /** 为 true 时忽略拖拽（如正在生成中）。 */
  disabled?: boolean
}

/** 拖拽事件里带的确实是文件（而不是选中的文字、链接）。 */
function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types || []).includes('Files')
}

/**
 * 给任意容器加“拖文件进来上传”的能力。
 *
 * dragenter/dragleave 会在鼠标划过子元素时反复触发，所以用计数器记录进出层数，
 * 归零才算真正离开——否则高亮会一直闪。
 */
export function useFileDrop({ onFiles, accept, disabled }: FileDropOptions) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  const reset = useCallback(() => {
    depth.current = 0
    setDragging(false)
  }, [])

  const onDragEnter = useCallback(
    (event: DragEvent) => {
      if (disabled || !hasFiles(event)) return
      event.preventDefault()
      depth.current += 1
      setDragging(true)
    },
    [disabled],
  )

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (disabled || !hasFiles(event)) return
      // 必须拦掉 dragover，否则浏览器不认这是投放区，drop 根本不会触发。
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    [disabled],
  )

  const onDragLeave = useCallback(
    (event: DragEvent) => {
      if (disabled || !hasFiles(event)) return
      event.preventDefault()
      depth.current -= 1
      if (depth.current <= 0) reset()
    },
    [disabled, reset],
  )

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (disabled || !hasFiles(event)) return
      event.preventDefault()
      reset()
      const dropped = Array.from(event.dataTransfer.files || [])
      const picked =
        accept === 'image' ? dropped.filter((f) => f.type.startsWith('image/')) : dropped
      if (picked.length > 0) onFiles(picked)
    },
    [accept, disabled, onFiles, reset],
  )

  return { dragging, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}
