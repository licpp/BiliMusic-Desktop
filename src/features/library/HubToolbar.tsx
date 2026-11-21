import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function HubToolbar({ className, summary, actions, actionsHost }: {
  className: string
  summary: ReactNode
  actions: ReactNode
  actionsHost?: HTMLElement | null
}) {
  return <div className={`${className} hub-list-toolbar`} data-actions-in-header={actionsHost ? '' : undefined}>
    <span className="hub-summary">{summary}</span>
    {actionsHost ? createPortal(actions, actionsHost) : actions}
  </div>
}
