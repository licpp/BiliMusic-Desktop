import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import { isMobile } from '../services/platform'

export type TabOption<T> = { id: T; label: string }

export function SegmentedTabs<T extends string>({ tabs, value, onChange, idPrefix, panelId, label, className }: {
  tabs: readonly TabOption<T>[]; value: T; onChange: (value: T) => void; idPrefix: string; panelId: string; label: string; className: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const selected = Math.max(0, tabs.findIndex(tab => tab.id === value))

  useLayoutEffect(() => {
    if (isMobile) return
    const list = listRef.current
    if (!list) return
    const syncIndicator = () => {
      const active = list.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[selected]
      if (!active || !active.offsetWidth) return
      list.style.setProperty('--tab-bar-x', `${active.offsetLeft}px`)
      list.style.setProperty('--tab-bar-w', `${active.offsetWidth}px`)
      if (!list.hasAttribute('data-bar-ready')) {
        // Defer enabling transition until after the initial position paints.
        requestAnimationFrame(() => list.setAttribute('data-bar-ready', ''))
      }
    }
    syncIndicator()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncIndicator)
      return () => window.removeEventListener('resize', syncIndicator)
    }
    const observer = new ResizeObserver(syncIndicator)
    observer.observe(list)
    return () => observer.disconnect()
  }, [selected, tabs.length])

  return <div ref={listRef} className={`${className} segmented-tabs`} role="tablist" aria-label={label}
    style={{ '--tab-index': selected, '--tab-count': tabs.length } as CSSProperties}
    onKeyDown={event => {
      const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
      if (!step && event.key !== 'Home' && event.key !== 'End') return
      event.preventDefault()
      const index = step ? (selected + step + tabs.length) % tabs.length : event.key === 'Home' ? 0 : tabs.length - 1
      onChange(tabs[index].id)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[index]?.focus()
    }}>
    <span className="segmented-tab-indicator" data-swipe-indicator aria-hidden="true" />
    {tabs.map(tab => <button key={tab.id} id={`${idPrefix}-${tab.id}`} role="tab" aria-selected={tab.id === value} aria-controls={panelId}
      tabIndex={tab.id === value ? 0 : -1} onClick={() => onChange(tab.id)}>
      {tab.label}
    </button>)}
  </div>
}
