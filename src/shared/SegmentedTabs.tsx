import type { CSSProperties } from 'react'

export type TabOption<T> = { id: T; label: string }

export function SegmentedTabs<T extends string>({ tabs, value, onChange, idPrefix, panelId, label, className }: {
  tabs: readonly TabOption<T>[]; value: T; onChange: (value: T) => void; idPrefix: string; panelId: string; label: string; className: string
}) {
  const selected = tabs.findIndex(tab => tab.id === value)
  return <div className={`${className} segmented-tabs`} role="tablist" aria-label={label}
    style={{ '--tab-index': Math.max(0, selected), '--tab-count': tabs.length } as CSSProperties}
    onKeyDown={event => {
      const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
      if (!step && event.key !== 'Home' && event.key !== 'End') return
      event.preventDefault()
      const index = step ? (selected + step + tabs.length) % tabs.length : event.key === 'Home' ? 0 : tabs.length - 1
      onChange(tabs[index].id)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[index]?.focus()
    }}>
    {tabs.map(tab => <button key={tab.id} id={`${idPrefix}-${tab.id}`} role="tab" aria-selected={tab.id === value} aria-controls={panelId}
      tabIndex={tab.id === value ? 0 : -1} onClick={() => onChange(tab.id)}>
      {tab.label}
    </button>)}
  </div>
}
