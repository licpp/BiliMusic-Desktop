import { useLayoutEffect, useRef } from 'react'

const storageKey = 'bilimusic-library-width'
const defaultWidth = 210
const minWidth = 180
const maxWidth = 420

export function SidebarResizeHandle() {
  const handle = useRef<HTMLDivElement>(null)
  const preferred = useRef(defaultWidth)
  const width = useRef(defaultWidth)
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(
    null,
  )
  const limit = () =>
    Math.max(
      minWidth,
      Math.min(
        maxWidth,
        (handle.current?.parentElement?.clientWidth ?? 1180) - 68 - 560,
      ),
    )
  const apply = (value: number) => {
    const next = Math.round(Math.max(minWidth, Math.min(limit(), value)))
    width.current = next
    handle.current?.parentElement?.style.setProperty(
      '--library-width',
      `${next}px`,
    )
    handle.current?.setAttribute('aria-valuenow', String(next))
    handle.current?.setAttribute('aria-valuemax', String(limit()))
  }
  const save = (value: number) => {
    apply(value)
    preferred.current = width.current
    try {
      localStorage.setItem(storageKey, String(preferred.current))
    } catch {
      /* Keep resizing available when storage is full. */
    }
  }
  const finish = (commit: boolean) => {
    const active = drag.current
    if (!active) return
    drag.current = null
    delete handle.current?.parentElement?.dataset.resizingSidebar
    if (commit) save(width.current)
    else apply(active.width)
    if (handle.current?.hasPointerCapture(active.pointerId))
      handle.current.releasePointerCapture(active.pointerId)
  }

  useLayoutEffect(() => {
    const shell = handle.current?.parentElement
    if (!shell) return
    try {
      const stored = Number(localStorage.getItem(storageKey))
      if (Number.isFinite(stored) && stored >= minWidth && stored <= maxWidth)
        preferred.current = stored
    } catch {
      /* Use the default width if storage is unavailable. */
    }
    apply(preferred.current)
    const observer = new ResizeObserver(() => {
      if (!drag.current) apply(preferred.current)
    })
    observer.observe(shell)
    return () => {
      observer.disconnect()
      delete shell.dataset.resizingSidebar
    }
  }, [])

  return (
    <div
      ref={handle}
      className="sidebar-resize-handle"
      role="separator"
      tabIndex={0}
      aria-label="调整歌单与收藏侧栏宽度"
      aria-controls="library-navigation"
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={defaultWidth}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          width: width.current,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        event.currentTarget.parentElement!.dataset.resizingSidebar = 'true'
      }}
      onPointerMove={(event) => {
        const active = drag.current
        if (active?.pointerId === event.pointerId)
          apply(active.width + event.clientX - active.x)
      }}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(true)}
      onDoubleClick={() => save(defaultWidth)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          save(width.current + (event.key === 'ArrowLeft' ? -10 : 10))
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          save(event.key === 'Home' ? minWidth : limit())
        }
      }}
    />
  )
}
