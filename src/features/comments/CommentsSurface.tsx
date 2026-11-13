import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isMobile } from '../../services/platform'

const mobileQuery = '(max-width: 960px)'
function subscribeToLayout(listener: () => void) {
  const media = window.matchMedia(mobileQuery)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
const isMobileLayout = () => isMobile || window.matchMedia(mobileQuery).matches

export function CommentsSurface({ children, onClose, onBackFromThread, onBackFromComposer, video }: { children: ReactNode; onClose: () => void; onBackFromThread?: () => void; onBackFromComposer?: () => void; video?: HTMLElement | null }) {
  const mobile = useSyncExternalStore(subscribeToLayout, isMobileLayout)
  const [expanded, setExpanded] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const gesture = useRef<number | null>(null)
  const suppressClick = useRef(false)
  const shift = useRef(0)
  useLayoutEffect(() => {
    if (!mobile || !panel.current) return
    const sheet = panel.current
    const update = () => {
      const overlay=sheet.parentElement?.getBoundingClientRect()
      const height=overlay?.height ?? window.innerHeight
      const target=video ? video.getBoundingClientRect().bottom-(overlay?.top ?? 0) : height*.26
      const collapsed=Math.max(230,Math.min(720,height-target))
      shift.current=Math.max(0,height-collapsed)
      sheet.style.setProperty('--comments-collapsed-height',`${collapsed}px`)

    }
    const observer = new ResizeObserver(update)
    observer.observe(sheet)
    if (video) observer.observe(video)
    window.addEventListener('resize', update)
    update()
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [mobile, video])
  const forceExpanded = Boolean(onBackFromThread)
  const back = () => {
    if (onBackFromComposer) onBackFromComposer()
    else if (onBackFromThread) onBackFromThread()
    else if (expanded) setExpanded(false)
    else onClose()
  }
  useEffect(() => {
    if (!mobile) return
    const onBack = (event: Event) => {
      if (event.defaultPrevented) return
      event.preventDefault()
      event.stopImmediatePropagation()
      back()
    }
    window.addEventListener('bilimusic-back', onBack, true)
    return () => window.removeEventListener('bilimusic-back', onBack, true)
  }, [mobile, expanded, onBackFromThread, onBackFromComposer, onClose])

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

  if (!mobile) return <aside className="comments-panel" aria-label="歌曲评论" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();back()}}}>{children}</aside>

  return createPortal(<div className="comments-sheet-overlay" data-video={video && !expanded && !forceExpanded ? true : undefined} onPointerDown={event => { if (event.target === event.currentTarget) onClose() }} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); back() }
    if (event.key !== 'Tab') return
    const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, [contenteditable="true"], a[href], [tabindex="0"]')
    if (!controls?.length) return
    const first = controls[0], last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }}>
    <section ref={panel} className={`comments-panel comments-sheet${expanded || forceExpanded ? ' expanded' : ''} mobile-comments`} role="dialog" aria-modal="true" aria-label="歌曲评论" onFocusCapture={event => { if (event.target instanceof HTMLElement&&event.target.matches('textarea,[contenteditable="true"]')) setExpanded(true) }}>
      <button className="comments-sheet-handle" type="button" aria-label={expanded ? '收起评论面板' : '展开评论面板'} aria-expanded={expanded}
        onPointerDown={event => { gesture.current = event.clientY; suppressClick.current = false; panel.current?.setAttribute('data-dragging', ''); event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={event => {
          if (gesture.current === null) return
          const delta = event.clientY - gesture.current
          const distance = forceExpanded ? Math.max(0, delta) : expanded ? Math.max(0, delta) : Math.max(-shift.current, delta)
          panel.current?.style.setProperty('--comment-drag-y', `${distance}px`)
        }}
        onPointerCancel={() => { gesture.current = null; panel.current?.removeAttribute('data-dragging'); panel.current?.style.removeProperty('--comment-drag-y') }}
        onPointerUp={event => {
          if (gesture.current === null) return
          const distance = event.clientY - gesture.current
          gesture.current = null
          panel.current?.removeAttribute('data-dragging'); panel.current?.style.removeProperty('--comment-drag-y')
          if (Math.abs(distance) < 40) return
          suppressClick.current = true
          if (distance < 0) setExpanded(true)
          else back()
        }}
        onClick={() => { if (suppressClick.current) { suppressClick.current = false; return }; if (!forceExpanded) setExpanded(value => !value) }}><span /></button>
      {children}
    </section>
  </div>, document.body)
}
