import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useCompactLayout } from './useCompactLayout'
import { MoreHorizontal, X } from 'lucide-react'
import { isMobile } from '../services/platform'

export function ActionMenu({ label = '更多操作', panel = false, sheet = false, touchSheet = false, floating = false, icon, contextPosition, onOpenChange, children }: { label?: string; panel?: boolean; sheet?: boolean; touchSheet?: boolean; floating?: boolean; icon?: ReactNode; contextPosition?: {left:number;top:number;nonce:number}; onOpenChange?: (open: boolean) => void; children: (close: () => void) => ReactNode }) {
  const compact=useCompactLayout()
  const isSheet=!floating && (touchSheet || ((sheet || isMobile) && compact))
  const touch = isSheet && touchSheet
  const [position, setPosition] = useState<{ left: number; top: number; anchorTop?: number } | null>(null)
  const open = Boolean(position)
  useEffect(() => { onOpenChange?.(open); return () => { if (open) onOpenChange?.(false) } }, [open, onOpenChange])
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const movedHandle = useRef(false)
  const drag = useRef<{ id: number; y: number } | null>(null)
  const close = () => { drag.current = null; setPosition(null) }
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current?.id !== event.pointerId) return
    movedHandle.current ||= Math.abs(event.clientY - drag.current.y) > 8
    const dismiss = event.type === 'pointerup' && event.clientY - drag.current.y >= 56
    drag.current = null
    menu.current?.removeAttribute('data-touch-dragging')
    menu.current?.style.removeProperty('transform')
    if (dismiss) close()
  }
  useEffect(() => {
    if (contextPosition) setPosition(contextPosition)
  }, [contextPosition])
  useLayoutEffect(() => {
    const element = menu.current
    if (!element || !position || isSheet || floating) return
    const place = () => {
      const { width, height } = element.getBoundingClientRect()
      const maxTop = window.innerHeight - height - 8
      const above = position.anchorTop === undefined ? position.top : position.anchorTop - height - 6
      const top = position.top <= maxTop ? position.top : above
      element.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, position.left - (position.anchorTop === undefined ? 0 : width)))}px`
      element.style.top = `${Math.max(8, Math.min(maxTop, top))}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    return () => observer.disconnect()
  }, [position, isSheet, floating])
  useEffect(()=>{
    if((!isSheet && !floating)||!position)return
    const root=document.getElementById('root'),wasInert=root?.inert||false
    if(root)root.inert=true
    const trap=(event:KeyboardEvent)=>{if(event.key!=='Tab')return;const buttons=[...menu.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];const index=buttons.indexOf(document.activeElement as HTMLButtonElement);if((event.shiftKey&&index<=0)||(!event.shiftKey&&index===buttons.length-1)){event.preventDefault();buttons[event.shiftKey?buttons.length-1:0]?.focus()}}
    document.addEventListener('keydown',trap)
    return()=>{document.removeEventListener('keydown',trap);if(root)root.inert=wasInert;trigger.current?.focus()}
  },[isSheet,floating,!!position])
  useEffect(() => {
    if (!position) return
    const dismiss = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) {
      // The scrim consumes the complete gesture, including its later click.
      if ((event.target as HTMLElement).closest('.action-menu-no-scrim, .action-sheet-scrim')) return
      close()
    } }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); trigger.current?.focus() } }
    const back = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); close() }
    const scroll = (event: Event) => {
      const scroller = event.target
      // Dismiss only when scrolling moves this menu's anchor. Automatic lyric
      // scrolling must not close a menu attached to the fixed page header.
      if (scroller === document || scroller === window || (scroller instanceof Element && trigger.current && scroller.contains(trigger.current))) close()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    window.addEventListener('bilimusic-back', back, true)
    if (!touch) window.addEventListener('resize', close)
    window.addEventListener('scroll', scroll, true)
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape)
      window.removeEventListener('bilimusic-back', back, true); window.removeEventListener('resize', close); window.removeEventListener('scroll', scroll, true)
    }
  }, [position, touch])
  return <><button ref={trigger} type="button" className="action-menu-trigger" aria-label={label} title={label} aria-haspopup={panel ? 'dialog' : 'menu'} aria-expanded={Boolean(position)} onClick={(event) => {
    event.stopPropagation()
    if (position) { close(); return }
    const rect = trigger.current!.getBoundingClientRect()
    setPosition({ left: rect.right, top: rect.bottom + 6, anchorTop: rect.top })
  }}>{icon ?? <MoreHorizontal size={20} />}</button>{position && createPortal(<div className="action-menu-portal"><div className={isSheet ? 'action-sheet-scrim' : `action-menu-no-scrim${floating ? ' action-menu-floating-scrim' : ''}`} onClick={close}/><div ref={menu} data-overflow-panel data-touch-sheet={touch || undefined} className={`action-menu-panel ${isSheet ? 'action-menu-sheet' : ''}${floating ? ' action-menu-floating-panel' : ''}`} role={panel ? 'dialog' : 'menu'} aria-label={label} aria-modal={touch || undefined} onKeyDown={(event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || (event.target as HTMLElement).matches('input,select,textarea')) return
    event.preventDefault()
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
  }}>{floating && <header className="action-menu-floating-heading"><span>{label}</span><button type="button" aria-label="关闭设置" onClick={close}><X size={18}/></button></header>}{touch ? <header className="touch-sheet-header">
    <button type="button" className="touch-sheet-handle" aria-label="收起设置" onClick={event => { if (event.detail === 0 || !movedHandle.current) close() }}
      onPointerDown={event => {
        movedHandle.current = false
        drag.current = { id: event.pointerId, y: event.clientY }
        menu.current?.setAttribute('data-touch-dragging', '')
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        if (drag.current?.id === event.pointerId) {
          movedHandle.current ||= Math.abs(event.clientY - drag.current.y) > 8
          menu.current?.style.setProperty('transform', 'translateY(' + Math.max(0, event.clientY - drag.current.y) + 'px)')
        }
      }}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}><span /></button>
    <div><strong>{label}</strong><button type="button" aria-label="关闭设置" onClick={close}><X size={18}/></button></div>
  </header> : isSheet && <div className="action-sheet-heading">{label}</div>}
  {children(close)}{isSheet && !touch && <button onClick={close}>取消</button>}</div></div>, document.body)}</>
}
