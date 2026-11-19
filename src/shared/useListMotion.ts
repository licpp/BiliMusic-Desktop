import { startTransition, useLayoutEffect, useReducer, useRef, type RefObject } from 'react'
import { afterListMotion, listUpdatesHeld } from './navigationListMotion'
import { listPlaceholderDelay, listRevealDelay } from './listLoadingTiming'
import { accountEpoch } from '../services/accountScope'

export function useListDataDuringNavigation<T>(data: T | undefined, scope: unknown, paceLoading = true) {
  const [, retry] = useReducer((revision: number) => revision + 1, 0)
  const accountSession = accountEpoch()
  const committed = useRef<{ scope: unknown; accountSession: number; data?: T; loadingSince?: number }>({ scope, accountSession })
  const sameList = scope === committed.current.scope && accountSession === committed.current.accountSession
  const delay = paceLoading && sameList && data !== undefined ? listRevealDelay(committed.current.loadingSince, performance.now()) : 0
  // Never carry existing rows into the loading state of another query.
  const visible = data !== undefined && (listUpdatesHeld() || delay > 0) ? (sameList ? committed.current.data : undefined) : data
  useLayoutEffect(() => {
    const loadingSince = visible === undefined ? (sameList ? committed.current.loadingSince : undefined) ?? performance.now() : undefined
    committed.current = { scope, accountSession, data: visible, loadingSince }
    if (visible === data) return
    const reveal = () => startTransition(retry)
    if (!delay) return afterListMotion(reveal)
    let cancelMotion: (() => void) | undefined
    const timer = window.setTimeout(() => {
      if (listUpdatesHeld()) cancelMotion = afterListMotion(reveal)
      else reveal()
    }, delay)
    return () => { window.clearTimeout(timer); cancelMotion?.() }
  }, [visible, data, scope, accountSession, sameList, delay])
  return visible
}

export function useListReveal(ref: RefObject<HTMLElement | null>, loading: boolean, hasRows: boolean, active = true) {
  const loadingSince = useRef<number | undefined>(undefined)
  const revealed = useRef(false)
  useLayoutEffect(() => {
    if (loading) {
      loadingSince.current ??= performance.now()
      return
    }
    const hadPlaceholder = loadingSince.current !== undefined && performance.now() - loadingSince.current >= listPlaceholderDelay
    loadingSince.current = undefined
    const list = ref.current
    if (revealed.current || !active || loading || !hasRows || !list || list.closest('[hidden],[inert]')) return
    revealed.current = true
    if (!hadPlaceholder || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const animation = list.animate?.([{ opacity: .58 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' })
    return () => animation?.cancel()
  }, [ref, loading, hasRows, active])
}
