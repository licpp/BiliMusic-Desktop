import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isAndroid } from '../../services/platform'

const mobileQuery = '(max-width: 960px)'
function subscribeToLayout(listener: () => void) {
  const media = window.matchMedia(mobileQuery)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
const isMobileLayout = () => isAndroid || window.matchMedia(mobileQuery).matches

export function CommentsSurface({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const mobile = useSyncExternalStore(subscribeToLayout, isMobileLayout)
  const [expanded, setExpanded] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const gesture = useRef<number | null>(null)
  const suppressClick = useRef(false)

  useEffect(() => {
    if (!mobile) return
    const previous = document.activeElement as HTMLElement | null
    const root = document.getElementById('root')
    const wasInert = root?.inert ?? false
    if (root) root.inert = true
    panel.current?.querySelector<HTMLButtonElement>('button[aria-label="关闭评论"]')?.focus({ preventScroll: true })
    return () => {
      if (root) root.inert = wasInert
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [mobile])

  if (!mobile) return <aside className="comments-panel" aria-label="歌曲评论">{children}</aside>

  return createPortal(<div className="comments-sheet-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    if (event.key !== 'Tab') return
    const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, a[href], [tabindex="0"]')
    if (!controls?.length) return
    const first = controls[0], last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }}>
    <section ref={panel} className={`comments-panel comments-sheet${expanded ? ' expanded' : ''}`} role="dialog" aria-modal="true" aria-label="歌曲评论" onFocusCapture={event => { if (event.target instanceof HTMLTextAreaElement) setExpanded(true) }}>
      <button className="comments-sheet-handle" type="button" aria-label={expanded ? '收起评论面板' : '展开评论面板'} aria-expanded={expanded}
        onPointerDown={event => { gesture.current = event.clientY; suppressClick.current = false; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerCancel={() => { gesture.current = null }}
        onPointerUp={event => {
          if (gesture.current === null) return
          const distance = event.clientY - gesture.current
          gesture.current = null
          if (Math.abs(distance) < 40) return
          suppressClick.current = true
          if (distance < 0) setExpanded(true)
          else if (expanded) setExpanded(false)
          else onClose()
        }}
        onClick={() => { if (suppressClick.current) { suppressClick.current = false; return }; setExpanded(value => !value) }}><span /></button>
      {children}
    </section>
  </div>, document.body)
}
