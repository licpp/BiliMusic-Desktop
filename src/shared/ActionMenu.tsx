import { isTopOverlay, lockAppForPortal } from './overlayStack'
import { useOverlayDismiss } from './useOverlayDismiss'
import { usePanelPresence } from './usePanelPresence'
import { usePanelReveal } from './usePanelReveal'
import { useVerticalDismiss } from './useVerticalDismiss'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useCompactLayout } from './useCompactLayout'
import { MoreHorizontal, X } from 'lucide-react'
import { isMobile } from '../services/platform'

export function ActionMenu({ panelClassName = '', label = '更多操作', panel = false, sheet = false, touchSheet = false, floating = false, disabled, icon, contextPosition, onOpenChange, children }: { panelClassName?: string; label?: string; panel?: boolean; sheet?: boolean; touchSheet?: boolean; floating?: boolean; disabled?: boolean; icon?: ReactNode; contextPosition?: {left:number;top:number;nonce:number}; onOpenChange?: (open: boolean) => void; children: (close: () => void) => ReactNode }) {
  const compact=useCompactLayout()
  const isSheet=!floating && (touchSheet || ((sheet || isMobile) && compact))
  const touch = isSheet && touchSheet
  const [position, setPosition] = useState<{ left: number; top: number; anchorTop?: number } | null>(null)
  const open = Boolean(position)
  const sheetPresent = usePanelPresence(open && isSheet, 150)
  useEffect(() => { onOpenChange?.(open); return () => { if (open) onOpenChange?.(false) } }, [open, onOpenChange])
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const portal = useRef<HTMLDivElement>(null)
  const close = () => setPosition(null)
  usePanelReveal(menu, open && isSheet)
  useOverlayDismiss(portal, open, close, true)
  const drag = useVerticalDismiss(menu, touch && open, close)
  useEffect(() => {
    if (contextPosition) setPosition(contextPosition)
  }, [contextPosition])
  useLayoutEffect(() => {
    const element = menu.current
    if (!element || !position || isSheet || floating) return
    const place = () => {
      const { width, height } = element.getBoundingClientRect()
      const root = document.documentElement
      const insets = root.hasAttribute('data-ohos-edge-to-edge') ? getComputedStyle(root) : undefined
      const clearance = (side: 'top' | 'right' | 'bottom' | 'left') => Math.max(8, Number.parseFloat(insets?.getPropertyValue(`--native-safe-${side}`) || '0'))
      const maxTop = window.innerHeight - height - clearance('bottom')
      const above = position.anchorTop === undefined ? position.top : position.anchorTop - height - 6
      const top = position.top <= maxTop ? position.top : above
      const left = position.anchorTop === undefined ? position.left : position.left - width
      element.style.left = `${Math.max(clearance('left'), Math.min(window.innerWidth - width - clearance('right'), left))}px`
      element.style.top = `${Math.max(clearance('top'), Math.min(maxTop, top))}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    return () => observer.disconnect()
  }, [position, isSheet, floating])
  useEffect(()=>{
    if((!isSheet && !floating)||!position)return
    const unlock = lockAppForPortal()
    const trap=(event:KeyboardEvent)=>{if(event.key!=='Tab'||!isTopOverlay(portal.current))return;const buttons=[...menu.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];const index=buttons.indexOf(document.activeElement as HTMLButtonElement);if((event.shiftKey&&index<=0)||(!event.shiftKey&&index===buttons.length-1)){event.preventDefault();buttons[event.shiftKey?buttons.length-1:0]?.focus()}}
    document.addEventListener('keydown',trap)
    return()=>{document.removeEventListener('keydown',trap);unlock(); if (!trigger.current?.closest('[inert]')) trigger.current?.focus({ preventScroll: true })}
  },[isSheet,floating,!!position])
  useEffect(() => {
    if (!position) return
    const dismiss = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) {
      // The scrim consumes the complete gesture, including its later click.
      if ((event.target as HTMLElement).closest('.action-menu-no-scrim, .action-sheet-scrim')) return
      close()
    } }
    const scroll = (event: Event) => {
      const scroller = event.target
      // Dismiss only when scrolling moves this menu's anchor. Automatic lyric
      // scrolling must not close a menu attached to the fixed page header.
      if (scroller === document || scroller === window || (scroller instanceof Element && trigger.current && scroller.contains(trigger.current))) close()
    }
    document.addEventListener('pointerdown', dismiss)
    if (!touch) window.addEventListener('resize', close)
    window.addEventListener('scroll', scroll, true)
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    return () => {
      if (!isSheet && !floating && (!document.activeElement || document.activeElement === document.body)) {
        trigger.current?.focus({ preventScroll: true })
      }
      document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', close); window.removeEventListener('scroll', scroll, true)
    }
  }, [position, touch, isSheet, floating])
  return <><button ref={trigger} type="button" disabled={disabled} className="action-menu-trigger" aria-label={label} title={label} aria-haspopup={panel ? 'dialog' : 'menu'} aria-expanded={Boolean(position)} onClick={(event) => {
    event.stopPropagation()
    if (position) { close(); return }
    const rect = trigger.current!.getBoundingClientRect()
    setPosition({ left: rect.right, top: rect.bottom + 6, anchorTop: rect.top })
  }}>{icon ?? <MoreHorizontal size={20} />}</button>{(open || isSheet && sheetPresent) && createPortal(<div ref={portal} className="action-menu-portal" inert={!open} data-sheet-open={open && isSheet || undefined}><div className={isSheet ? 'action-sheet-scrim' : `action-menu-no-scrim${floating ? ' action-menu-floating-scrim' : ''}`} onClick={close}/><div ref={menu} data-overflow-panel data-touch-sheet={touch || undefined} className={`action-menu-panel ${panelClassName} ${isSheet ? 'action-menu-sheet' : ''}${floating ? ' action-menu-floating-panel' : ''}`} role={panel ? 'dialog' : 'menu'} aria-label={label} aria-modal={touch || undefined} onKeyDown={(event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || (event.target as HTMLElement).matches('input,select,textarea')) return
    event.preventDefault()
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
  }}>{floating && <header className="action-menu-floating-heading"><span>{label}</span><button type="button" aria-label="关闭设置" onClick={close}><X size={18}/></button></header>}{touch ? <header className="touch-sheet-header">
    <button type="button" className="touch-sheet-handle" aria-label="收起设置" {...drag}><span /></button>
    <div><strong>{label}</strong><button type="button" aria-label="关闭设置" onClick={close}><X size={18}/></button></div>
  </header> : isSheet && <div className="action-sheet-heading">{label}</div>}
  {children(close)}{isSheet && !touch && <button onClick={close}>取消</button>}</div></div>, document.body)}</>
}
