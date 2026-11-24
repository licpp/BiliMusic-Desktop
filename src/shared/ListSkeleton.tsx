import type { CSSProperties } from 'react'
import { listPlaceholderDelay } from './listLoadingTiming'

export function ListSkeleton({ label, wide = false, immediate = false }: { label: string; wide?: boolean; immediate?: boolean }) {
  return <div className="list-skeleton" data-cover-wide={wide || undefined} data-immediate={immediate || undefined}
    style={{ '--list-placeholder-delay': `${listPlaceholderDelay}ms` } as CSSProperties} role="status" aria-label={label}>
    {[72, 53, 64, 46, 60, 56].map(width => <div className="list-skeleton-row" aria-hidden="true" key={width}>
      <span className="list-skeleton-artwork" />
      <span className="list-skeleton-copy">
        <span style={{ width: `${width}%` }} />
        <span />
      </span>
    </div>)}
  </div>
}
