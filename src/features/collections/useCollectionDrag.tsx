import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'

export function useCollectionDrag(title: string, options?: { folderId: string; onMove: (targetFolder: string) => void }) {
  const gesture = useRef<{ id: number; x: number; y: number } | undefined>(undefined)
  const suppressClick = useRef(false)
  const target = useRef<HTMLElement | null>(null)
  const frame = useRef<number | undefined>(undefined)
  const [drag, setDrag] = useState<{ x: number; y: number }>()
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined)

  const findTarget = (x: number, y: number) => {
    const folder = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-collection-folder]')
    return folder && folder.dataset.collectionFolder !== options?.folderId ? folder : null
  }
  const highlight = (folder: HTMLElement | null) => {
    if (target.current === folder) return
    target.current?.removeAttribute('data-drop-active')
    target.current = folder
    folder?.setAttribute('data-drop-active', '')
  }
  const stop = () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    frame.current = undefined
    gesture.current = undefined
    pointer.current = undefined
    highlight(null)
    setDrag(undefined)
  }
  useEffect(() => () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    target.current?.removeAttribute('data-drop-active')
  }, [])

  const scrollWhileDragging = () => {
    const point = pointer.current
    if (!point) return
    const scroller = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('.stage-scroll, .library-panel')
    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      const { top, bottom } = scroller.getBoundingClientRect()
      const edge = 32
      if (point.y < top + edge) scroller.scrollTop -= 8
      else if (point.y > bottom - edge) scroller.scrollTop += 8
      highlight(findTarget(point.x, point.y))
    }
    frame.current = requestAnimationFrame(scrollWhileDragging)
  }
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!options || event.pointerType === 'touch' || !event.isPrimary || event.button !== 0 || gesture.current) return
    suppressClick.current = false
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const press = gesture.current
    if (press?.id !== event.pointerId) return
    const point = { x: event.clientX, y: event.clientY }
    if (!pointer.current && Math.hypot(point.x - press.x, point.y - press.y) < 6) return
    suppressClick.current = true
    pointer.current = point
    highlight(findTarget(point.x, point.y))
    setDrag(point)
    if (frame.current === undefined) frame.current = requestAnimationFrame(scrollWhileDragging)
  }
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (gesture.current?.id !== event.pointerId) return
    const folder = pointer.current ? findTarget(event.clientX, event.clientY)?.dataset.collectionFolder : undefined
    stop()
    if (folder) options?.onMove(folder)
  }
  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: stop, onLostPointerCapture: stop },
    consumeClick: () => { const value = suppressClick.current; suppressClick.current = false; return value },
    preview: drag && createPortal(<span className="collection-drag-preview" aria-hidden="true"
      style={{ left: Math.min(drag.x + 12, window.innerWidth - 176), top: Math.min(drag.y + 12, window.innerHeight - 38) }}>{title}</span>, document.body),
  }
}
