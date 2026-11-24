import { useEffect, useRef, type PointerEvent, type RefObject, type MouseEvent } from 'react'
import { dragDismissDirection, swipeAxis } from './gestureRelease'

type DismissOptions = {
  expand?: () => void
  upLimit?: () => number
  tap?: () => void
  settle?: (offset: number, dismissed: boolean) => void
}

export function useVerticalDismiss<T extends HTMLElement = HTMLButtonElement>(panel: RefObject<HTMLElement | null>, enabled: boolean, dismiss: () => void,
  { expand, upLimit, tap = dismiss, settle }: DismissOptions = {}) {
  const gesture = useRef<{ id: number; x: number; y: number; time: number; axis?: ReturnType<typeof swipeAxis> } | null>(null)
  const suppressClick = useRef(false)
  const reset = () => {
    gesture.current = null
    panel.current?.removeAttribute('data-panel-dragging')
    panel.current?.style.removeProperty('--panel-drag-y')
  }
  const release = (dismissed: boolean) => {
    const offset = settle && Number.parseFloat(panel.current?.style.getPropertyValue('--panel-drag-y') || '0')
    reset()
    if (offset) settle?.(offset, dismissed)
  }
  useEffect(() => {
    if (!enabled) reset()
    return reset
  }, [enabled])

  return {
    onPointerDown(event: PointerEvent<T>) {
      suppressClick.current = false
      if (!enabled || !event.isPrimary || event.button !== 0 || event.pointerType === 'mouse' ||
          panel.current?.hasAttribute('data-player-moving')) return
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp }
      if (event.target instanceof Element) event.target.setPointerCapture(event.pointerId)
      panel.current?.setAttribute('data-panel-dragging', '')
    },
    onPointerMove(event: PointerEvent<T>) {
      const pointer = gesture.current
      if (pointer?.id !== event.pointerId) return
      const distance = event.clientY - pointer.y
      pointer.axis ??= swipeAxis(event.clientX - pointer.x, distance)
      suppressClick.current ||= Boolean(pointer.axis)
      if (pointer.axis !== 'vertical') return
      panel.current?.style.setProperty('--panel-drag-y', `${Math.max(-(upLimit?.() ?? 0), distance)}px`)
    },
    onPointerUp(event: PointerEvent<T>) {
      const pointer = gesture.current
      if (pointer?.id !== event.pointerId) return
      const distance = event.clientY - pointer.y
      const axis = pointer.axis ?? swipeAxis(event.clientX - pointer.x, distance)
      const direction = axis === 'vertical' ? dragDismissDirection(distance, event.timeStamp - pointer.time) : 0
      suppressClick.current ||= Boolean(axis)
      if (direction > 0 && panel.current?.matches('.lyrics-view')) {
        panel.current.style.setProperty('--lyrics-exit-y', `${Math.max(0, distance)}px`)
      }
      release(direction > 0)
      if (direction > 0) dismiss()
      if (direction < 0) expand?.()
    },
    onPointerCancel: () => release(false),
    onLostPointerCapture(event: PointerEvent<T>) {
      if (gesture.current?.id === event.pointerId) release(false)
    },
    onClick(event: MouseEvent<T>) {
      if (event.detail === 0 || !suppressClick.current) tap()
      suppressClick.current = false
    }
  }
}
