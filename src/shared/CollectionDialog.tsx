import { isTopOverlay, lockAppForPortal } from './overlayStack'
import { useOverlayDismiss } from './useOverlayDismiss'
import { useVerticalDismiss } from './useVerticalDismiss'
import { createPortal } from 'react-dom'
import { useEffect, useRef, type ReactNode } from 'react'
import { useCompactLayout } from './useCompactLayout'
import { X } from 'lucide-react'

export function CollectionDialog({ title, onClose, children, className = '', mobileSheet = false }: {mobileSheet?:boolean;title:string;className?:string;onClose:()=>void;children:ReactNode}) {
  const compact = useCompactLayout()
  const sheet = mobileSheet && compact
  const layer = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const drag = useVerticalDismiss(panel, sheet, onClose)
  useOverlayDismiss(layer, true, onClose, true)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const unlock = lockAppForPortal()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !isTopOverlay(layer.current)) return
      const controls = Array.from(layer.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)'))
      const index = controls.indexOf(document.activeElement as HTMLElement)
      if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === controls.length - 1)) {
        event.preventDefault()
        controls[event.shiftKey ? controls.length - 1 : 0]?.focus()
      }
    }
    document.addEventListener('keydown', keyboard, true)
    const initialFocus = layer.current?.querySelector<HTMLElement>('[data-dialog-autofocus]')
    const focusTarget = initialFocus ?? layer.current?.querySelector<HTMLElement>('header button,.collection-sheet-handle,input,button')
    focusTarget?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('keydown', keyboard, true)
      unlock()
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
    }
  }, [])
  return createPortal(<div ref={layer} className={`dialog-backdrop collection-dialog-layer${sheet?' collection-dialog-sheet-layer':''}`} onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section ref={panel} className={'collection-dialog ' + className+(sheet?' collection-dialog-mobile-sheet':'')} role="dialog" aria-modal="true" aria-label={title}>
    {sheet && <button type="button" className="collection-sheet-handle" aria-label={`收起${title}`} {...drag}><span/></button>}
    <header><h3>{title}</h3>{!sheet&&<button className="collection-icon" aria-label="关闭" onClick={onClose}><X size={19}/></button>}</header>{children}</section></div>,document.body)
}
