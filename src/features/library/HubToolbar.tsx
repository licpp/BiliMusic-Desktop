import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function HubToolbar({ className, summary, actions, actionsHost }: {
  className: string
  summary: ReactNode
  actions: ReactNode
  actionsHost?: HTMLElement | null
}) {
  // The wide layout reserves the header slot even before it mounts and for inactive panes.
  const inHeader = actionsHost !== undefined
  return <div className={`${className} hub-list-toolbar`} data-actions-in-header={inHeader ? '' : undefined}>
    <span className="hub-summary">{summary}</span>
    {inHeader ? actionsHost && createPortal(actions, actionsHost) : actions}
  </div>
}
