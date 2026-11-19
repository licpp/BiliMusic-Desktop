import { startTransition, useEffect, useRef, useState } from 'react'
import { accountEpoch } from '../services/accountScope'
import { afterListMotion } from './navigationListMotion'

const rowsPerBatch = 24

// Limit DOM work without limiting the data used by search, selection or playback.
export function useListRows<T>(rows: T[], scope: string, { active = true, through = -1 }: {
  active?: boolean
  through?: number
} = {}) {
  const key = `${accountEpoch()}:${scope}`
  const [batch, setBatch] = useState({ key, count: rowsPerBatch })
  const count = Math.max(batch.key === key ? batch.count : rowsPerBatch, through + 1)
  const more = rows.length > count && typeof IntersectionObserver !== 'undefined'
  const tail = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (through < rowsPerBatch) return
    setBatch(current => current.key === key && current.count > through ? current : { key, count: through + 1 })
  }, [key, through])
  useEffect(() => {
    const target = tail.current
    if (!active || !more || !target) return
    let cancel: (() => void) | undefined
    const root = target.closest('.swipe-pages-fill .swipe-pane-content, .stage-scroll, .mobile-page-content, .collection-dialog, .library-panel')
    const observer = new IntersectionObserver(([entry]) => {
      cancel?.()
      if (entry.isIntersecting && !target.closest('[inert],[hidden]')) {
        cancel = afterListMotion(() => startTransition(() => {
          if (target.isConnected && !target.closest('[inert],[hidden]')) setBatch({ key, count: count + rowsPerBatch })
        }))
      }
    }, { root, rootMargin: '0px 0px 320px' })
    observer.observe(target)
    return () => { cancel?.(); observer.disconnect() }
  }, [active, count, key, more])
  return { rows: more ? rows.slice(0, count) : rows, more, tail }
}
