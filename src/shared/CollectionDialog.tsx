import { createPortal } from 'react-dom'
import { useEffect, useRef, type ReactNode } from 'react'
import { isMobile } from '../services/platform'
import { useCompactLayout } from './useCompactLayout'
import { X } from 'lucide-react'

export function CollectionDialog({ title, onClose, children, className = '', mobileSheet = false }: {mobileSheet?:boolean;title:string;className?:string;onClose:()=>void;children:ReactNode}) {
  const compact=useCompactLayout(),sheet=mobileSheet&&(isMobile||compact)
  const drag=useRef<number|null>(null),moved=useRef(false)
  const layer=useRef<HTMLDivElement>(null), dismiss=useRef(onClose)
  dismiss.current=onClose
  useEffect(()=>{
    const root=document.getElementById('root'),previous=document.activeElement as HTMLElement|null
    const wasInert=root?.inert || false
    if(root)root.inert=true
    const top=()=>[...document.querySelectorAll('.collection-dialog-layer')].at(-1)===layer.current
    const keyboard=(e:KeyboardEvent)=>{
      if(!top() || document.querySelector('[data-overflow-panel], .track-context-menu, .playlist-picker-layer'))return
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();dismiss.current()}
      if(e.key==='Tab'){
        const buttons=[...layer.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')]
        const index=buttons.indexOf(document.activeElement as HTMLElement)
        if((e.shiftKey&&index<=0)||(!e.shiftKey&&index===buttons.length-1)){e.preventDefault();buttons[e.shiftKey?buttons.length-1:0]?.focus()}
      }
    }
    const back=(e:Event)=>{if(top() && !document.querySelector('[data-overflow-panel], .track-context-menu, .playlist-picker-layer')){e.preventDefault();e.stopImmediatePropagation();dismiss.current()}}
    document.addEventListener('keydown',keyboard,true);window.addEventListener('bilimusic-back',back,true)
    layer.current?.querySelector<HTMLElement>('input,button')?.focus()
    return()=>{document.removeEventListener('keydown',keyboard,true);window.removeEventListener('bilimusic-back',back,true);if(root)root.inert=wasInert;if(previous?.isConnected&&!previous.closest('[inert]'))previous.focus()}
  },[])
  const resetDrag=()=>{drag.current=null;layer.current?.style.removeProperty('--sheet-drag-y')}
  return createPortal(<div ref={layer} className={`dialog-backdrop collection-dialog-layer${sheet?' collection-dialog-sheet-layer':''}`} onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section className={'collection-dialog ' + className+(sheet?' collection-dialog-mobile-sheet':'')} role="dialog" aria-modal="true" aria-label={title}>
    {sheet&&<button type="button" className="collection-sheet-handle" aria-label={`收起${title}`}
      onPointerDown={event=>{drag.current=event.clientY;moved.current=false;event.currentTarget.setPointerCapture(event.pointerId)}}
      onPointerMove={event=>{if(drag.current===null)return;const delta=Math.max(0,event.clientY-drag.current);if(delta>8)moved.current=true;layer.current?.style.setProperty('--sheet-drag-y',`${delta}px`)}}
      onPointerCancel={resetDrag} onPointerUp={event=>{const distance=drag.current===null?0:event.clientY-drag.current;resetDrag();if(distance>64)onClose()}}
      onClick={()=>{if(!moved.current)onClose()}}><span/></button>}
    <header><h3>{title}</h3>{!sheet&&<button className="collection-icon" aria-label="关闭" onClick={onClose}><X size={19}/></button>}</header>{children}</section></div>,document.body)
}
