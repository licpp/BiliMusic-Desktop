import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'

export function ActionMenu({ label = '更多操作', panel = false, children }: { label?: string; panel?: boolean; children: (close: () => void) => ReactNode }) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = () => setPosition(null)
  useEffect(() => {
    if (!position) return
    const dismiss = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close() }
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
  }}><MoreHorizontal size={20} /></button>{position && createPortal(<div ref={menu} data-overflow-panel className="action-menu-panel" role={panel ? 'dialog' : 'menu'} aria-label={label} style={position} onKeyDown={(event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || (event.target as HTMLElement).matches('input')) return
    event.preventDefault()
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
  }}>{children(close)}</div>, document.body)}</>
}
