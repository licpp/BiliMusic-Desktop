import { useEffect, useRef, useState } from 'react'
import { accountEpoch } from '../services/accountScope'
import { cachedVideoPages, probeVideoPages } from '../services/videoPages'
import type { BiliVideoPart } from '../services/desktopApi'

export function useVisibleVideoPages(bvid: string, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const scope = accountEpoch()
  const [result, setResult] = useState<{ scope: number; bvid: string; pages: BiliVideoPart[] }>()
  const pages = (result?.bvid === bvid && result.scope === scope ? result.pages : undefined) ?? cachedVideoPages(bvid)
  useEffect(() => {
    if (!enabled || pages || !ref.current) return
    let timer = 0
    let controller: AbortController | undefined
    const cancel = () => { window.clearTimeout(timer); controller?.abort() }
    const observer = new IntersectionObserver(([entry]) => {
      cancel()
      if (!entry.isIntersecting) return
      controller = new AbortController()
      const signal = controller.signal
      timer = window.setTimeout(() => probeVideoPages({ scope, bvid, signal, onPages: pages => setResult({ scope, bvid, pages }) }), 140)
    }, { rootMargin: '100px' })
    observer.observe(ref.current)
    return () => { cancel(); observer.disconnect() }
  }, [bvid, enabled, pages, scope])
  return { ref, pages }
}
