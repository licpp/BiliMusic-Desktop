import { startTransition, useEffect, useRef, useState } from 'react'
import { accountEpoch } from '../services/accountScope'
import { afterListMotion } from './navigationListMotion'

const rowsPerBatch = 24
const renderedCounts = new Map<string, number>()

// Limit DOM work without limiting the data used by search, selection or playback.
export function useListRows<T>(rows: T[], scope: string, { active = true, through = -1, manualFallback = false }: {
  active?: boolean
  through?: number
  manualFallback?: boolean
} = {}) {
  const key = `${accountEpoch()}:${scope}`
  const [batch, setBatch] = useState({ key, count: renderedCounts.get(key) ?? rowsPerBatch })
  const count = Math.max(batch.key === key ? batch.count : renderedCounts.get(key) ?? rowsPerBatch, through + 1)
  useEffect(() => {
    if (count <= rowsPerBatch) return
    renderedCounts.delete(key)
    renderedCounts.set(key, count)
    if (renderedCounts.size > 48) {
      const first = renderedCounts.keys().next().value
      if (first !== undefined) renderedCounts.delete(first)
    }
  }, [key, count])
  const observed = typeof IntersectionObserver !== 'undefined'
  const more = rows.length > count && (observed || manualFallback)
  const loadMore = () => startTransition(() => setBatch({ key, count: count + rowsPerBatch }))
  const tail = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (through < rowsPerBatch) return
    setBatch(current => current.key === key && current.count > through ? current : { key, count: Math.max(renderedCounts.get(key) ?? rowsPerBatch, through + 1) })
  }, [key, through])
  useEffect(() => {
    const target = tail.current
    if (!active || !more || !target) return
    let cancel: (() => void) | undefined
    const root = target.closest('.swipe-pages-fill .swipe-pane-content, .stage-scroll, .mobile-page-content, .collection-dialog, .library-panel, .large-main')
    const load = () => {
      if (cancel || target.closest('[inert],[hidden]')) return
      cancel = afterListMotion(() => startTransition(() => {
        cancel = undefined
        if (target.isConnected && !target.closest('[inert],[hidden]')) setBatch({ key, count: count + rowsPerBatch })
      }))
    }
    if (observed) {
      const observer = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) load()
        else { cancel?.(); cancel = undefined }
      }, { root, rootMargin: '0px 0px 320px' })
      observer.observe(target)
      return () => { cancel?.(); observer.disconnect() }
    }
    let frame = 0
    const check = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const edge = target.getBoundingClientRect()
        const viewport = root?.getBoundingClientRect()
        if (edge.top <= (viewport?.bottom ?? window.innerHeight) + 320 && edge.bottom >= (viewport?.top ?? 0)) load()
      })
    }
    const scroller = root ?? window
    scroller.addEventListener('scroll', check, { passive: true })
    window.addEventListener('resize', check)
    check()
    return () => {
      scroller.removeEventListener('scroll', check)
      window.removeEventListener('resize', check)
      cancelAnimationFrame(frame)
      cancel?.()
    }
  }, [active, count, key, more, observed])
  return { rows: more ? rows.slice(0, count) : rows, more, tail, manualMore: more && !observed ? loadMore : undefined }
}
