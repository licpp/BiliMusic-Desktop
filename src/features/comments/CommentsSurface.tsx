import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { lockAppForPortal } from '../../shared/overlayStack'
import { subscribeMediaQuery } from '../../shared/subscribeMediaQuery'
import { useOverlayDismiss } from '../../shared/useOverlayDismiss'
import { usePanelReveal } from '../../shared/usePanelReveal'
import { useVerticalDismiss } from '../../shared/useVerticalDismiss'

const mobileQuery = '(max-width: 960px)'
function subscribeToLayout(listener: () => void) {
  return subscribeMediaQuery(window.matchMedia(mobileQuery), listener)
}
const isMobileLayout = () => window.matchMedia(mobileQuery).matches

export function CommentsSurface({ children, open, onClose, onBackFromThread, onBackFromComposer, video, chapterEditor }: { children: ReactNode; open: boolean; onClose: () => void; onBackFromThread?: () => void; onBackFromComposer?: () => void; video?: HTMLElement | null; chapterEditor?: boolean }) {
  const mobile = useSyncExternalStore(subscribeToLayout, isMobileLayout)
  const [expanded, setExpanded] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const shift = useRef(0)
  useLayoutEffect(() => {
    if (!mobile || !panel.current) return
    const sheet = panel.current
    const update = () => {
      const overlay=sheet.parentElement?.getBoundingClientRect()
      const height=overlay?.height ?? window.innerHeight
      const videoBottom = video ? video.getBoundingClientRect().bottom - (overlay?.top ?? 0) : 0
      const collapsed = video ? Math.max(180, height - videoBottom) : Math.min(680, height * .74)
      shift.current=Math.max(0,height-collapsed)
      const value = `${collapsed}px`
      if (sheet.style.getPropertyValue('--comments-collapsed-height') !== value) {
        sheet.style.setProperty('--comments-collapsed-height', value)
      }
    }
    update()
    const observer = new ResizeObserver(update)
    if (sheet.parentElement) observer.observe(sheet.parentElement)
    if (video) observer.observe(video)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [mobile, video])
  const forceExpanded = Boolean(onBackFromThread)
  const back = () => {
    if (onBackFromComposer) onBackFromComposer()
    else if (onBackFromThread) onBackFromThread()
    else if (expanded) setExpanded(false)
    else onClose()
  }
  const drag = useVerticalDismiss(panel, open && mobile, back, {
    expand: () => setExpanded(true),
    upLimit: () => expanded || forceExpanded ? 0 : shift.current,
    tap: () => { if (!forceExpanded) setExpanded(value => !value) },
  })
  useOverlayDismiss(layer, open && mobile, back, true)
  useOverlayDismiss(panel, open && !mobile, back)
  usePanelReveal(layer, open && mobile)
  usePanelReveal(panel, open && !mobile)
  useEffect(() => {
    if (!mobile || !open) return
    const previous = document.activeElement as HTMLElement | null
    const unlock = lockAppForPortal()
    panel.current?.focus({ preventScroll: true })
    return () => {
      unlock()
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
    }
  }, [mobile, open])

  if (!mobile) return <aside ref={panel} className="comments-panel" inert={!open} aria-label="歌曲评论">{children}</aside>

  return createPortal(<div ref={layer} inert={!open} className="comments-sheet-overlay" data-open={open || undefined}
    data-video={video && !expanded && !forceExpanded ? true : undefined}
    onClick={event => { if (event.target === event.currentTarget) back() }} onKeyDown={event => {
    if (event.key !== 'Tab') return
    const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, [contenteditable="true"], a[href], [tabindex="0"]') ?? [])
      .filter(control => !control.closest('[inert]'))
    if (!controls.length) return
    const first = controls[0], last = controls[controls.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }}>
    <section ref={panel} className={`comments-panel comments-sheet${expanded || forceExpanded ? ' expanded' : ''} mobile-comments`} data-chapter-editor={chapterEditor || undefined} role="dialog" aria-modal="true" aria-label="歌曲评论" tabIndex={-1} onFocusCapture={event => {
      if (!chapterEditor && event.target instanceof HTMLElement && event.target.matches('input,textarea,[contenteditable="true"]')) setExpanded(true)
    }}>
      <button className="comments-sheet-handle" type="button" aria-label={expanded ? '收起评论面板' : '展开评论面板'} aria-expanded={expanded} {...drag}><span /></button>
      {children}
    </section>
  </div>, document.body)
}
