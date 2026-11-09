import { createPortal } from 'react-dom'
import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function CollectionDialog({ title, onClose, children, wide = false }: {title:string;onClose:()=>void;children:ReactNode;wide?:boolean}) {
  const layer=useRef<HTMLDivElement>(null), dismiss=useRef(onClose)
  dismiss.current=onClose
  useEffect(()=>{
    const root=document.getElementById('root'),previous=document.activeElement as HTMLElement|null
    const wasInert=root?.inert || false
    if(root)root.inert=true
    const top=()=>[...document.querySelectorAll('.collection-dialog-layer')].at(-1)===layer.current
    const keyboard=(e:KeyboardEvent)=>{
      if(!top() || document.querySelector('[data-overflow-panel], .track-context-menu'))return
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();dismiss.current()}
      if(e.key==='Tab'){
        const buttons=[...layer.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')]
        const index=buttons.indexOf(document.activeElement as HTMLElement)
        if((e.shiftKey&&index<=0)||(!e.shiftKey&&index===buttons.length-1)){e.preventDefault();buttons[e.shiftKey?buttons.length-1:0]?.focus()}
      }
    }
    const back=(e:Event)=>{if(top() && !document.querySelector('[data-overflow-panel], .track-context-menu')){e.preventDefault();e.stopImmediatePropagation();dismiss.current()}}
    document.addEventListener('keydown',keyboard,true);window.addEventListener('bilimusic-back',back,true)
    layer.current?.querySelector<HTMLElement>('input,button')?.focus()
    return()=>{document.removeEventListener('keydown',keyboard,true);window.removeEventListener('bilimusic-back',back,true);if(root)root.inert=wasInert;if(previous?.isConnected&&!previous.closest('[inert]'))previous.focus()}
  },[])
  return createPortal(<div ref={layer} className="dialog-backdrop collection-dialog-layer" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section className={wide ? 'collection-dialog collection-dialog-wide' : 'collection-dialog'} role="dialog" aria-modal="true" aria-label={title}><header><h3>{title}</h3><button className="collection-icon" aria-label="关闭" onClick={onClose}><X size={19}/></button></header>{children}</section></div>,document.body)
}
