import { useEffect, useRef, useState } from 'react'
import { accountEpoch } from '../services/accountScope'
import { cachedVideoDetail, cachedVideoPages, probeVideoPages } from '../services/videoPages'
import type { BiliVideoPart, BiliVideoParts } from '../domain/bilibili'

export function useVisibleVideoPages<ElementType extends HTMLElement = HTMLDivElement>(bvid: string, enabled: boolean, withAccess = false) {
  const ref = useRef<ElementType>(null)
  const scope = accountEpoch()
  const [result, setResult] = useState<{ scope: number; bvid: string; pages: BiliVideoPart[]; detail?: BiliVideoParts }>()
  const matching = result?.bvid === bvid && result.scope === scope ? result : undefined
  const detail = matching?.detail ?? cachedVideoDetail(bvid)
  const pages = detail?.parts ?? matching?.pages ?? cachedVideoPages(bvid)
  const complete = withAccess ? detail !== undefined : pages !== undefined
  useEffect(() => {
    if (!enabled || complete || !ref.current) return
    let timer = 0
    let controller: AbortController | undefined
    const cancel = () => { window.clearTimeout(timer); controller?.abort() }
    const observer = new IntersectionObserver(([entry]) => {
      cancel()
      if (!entry.isIntersecting) return
      controller = new AbortController()
      const signal = controller.signal
      timer = window.setTimeout(() => probeVideoPages({ scope, bvid, signal, withAccess, onPages: (pages, detail) => setResult({ scope, bvid, pages, detail }) }), 140)
    }, { rootMargin: '100px' })
    observer.observe(ref.current)
    return () => { cancel(); observer.disconnect() }
  }, [bvid, enabled, complete, scope, withAccess])
  return { ref, pages, access: detail?.access }
}
