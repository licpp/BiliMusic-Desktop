import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useCompactLayout } from './useCompactLayout'
import { MoreHorizontal, X } from 'lucide-react'
import { isMobile } from '../services/platform'

export function ActionMenu({ label = '更多操作', panel = false, sheet = false, floating = false, contextPosition, children }: { label?: string; panel?: boolean; sheet?: boolean; floating?: boolean; contextPosition?: {left:number;top:number;nonce:number}; children: (close: () => void) => ReactNode }) {
  const compact=useCompactLayout()
  const isSheet=!floating && (sheet || isMobile) && compact
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = () => setPosition(null)
  useEffect(()=>{if(contextPosition)setPosition({left:Math.max(8,Math.min(window.innerWidth-248,contextPosition.left)),top:Math.max(8,Math.min(window.innerHeight-300,contextPosition.top))})},[contextPosition])
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
    window.addEventListener('resize', close)
    window.addEventListener('scroll', scroll, true)
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => {
      document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape)
      window.removeEventListener('bilimusic-back', back, true); window.removeEventListener('resize', close); window.removeEventListener('scroll', scroll, true)
    }
  }, [position])
  return <><button ref={trigger} type="button" className="action-menu-trigger" aria-label={label} title={label} aria-haspopup={panel ? 'dialog' : 'menu'} aria-expanded={Boolean(position)} onClick={(event) => {
    event.stopPropagation()
    if (position) { close(); return }
    const rect = trigger.current!.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - 248, rect.right - 240)), top: Math.max(8, Math.min(window.innerHeight - 300, rect.bottom + 6)) })
  }}><MoreHorizontal size={20} /></button>{position && createPortal(<><div className={isSheet ? 'action-sheet-scrim' : `action-menu-no-scrim${floating ? ' action-menu-floating-scrim' : ''}`} onClick={close}/><div ref={menu} data-overflow-panel className={`action-menu-panel ${isSheet ? 'action-menu-sheet' : ''}${floating ? ' action-menu-floating-panel' : ''}`} role={panel ? 'dialog' : 'menu'} aria-label={label} style={isSheet || floating ? undefined : position} onKeyDown={(event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || (event.target as HTMLElement).matches('input')) return
    event.preventDefault()
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
  }}>{floating && <header className="action-menu-floating-heading"><span>{label}</span><button type="button" aria-label="关闭设置" onClick={close}><X size={18}/></button></header>}{isSheet&&<div className="action-sheet-heading">{label}</div>}{children(close)}{isSheet&&<button onClick={close}>取消</button>}</div></>, document.body)}</>
}
