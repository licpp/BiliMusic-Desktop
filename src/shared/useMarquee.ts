import { useEffect, useState, type RefObject } from 'react'
import { animateMarquee, marqueeMotion } from './marquee'
import { subscribeMediaQuery } from './subscribeMediaQuery'

export function useMarquee(
  viewport: RefObject<HTMLElement | null>, track: RefObject<HTMLElement | null>, copy: RefObject<HTMLElement | null>,
  text: string, enabled: boolean, gap = 32, pauseOnHover = false,
) {
  const [scrolling, setScrolling] = useState(false)
  useEffect(() => {
    const heading = viewport.current, content = track.current, original = copy.current
    if (!heading || !content || !original || !enabled) { setScrolling(false); return }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let stop: (() => void) | undefined, previous = '', disposed = false
    const measure = () => {
      if (disposed) return
      const width = heading.clientWidth, textWidth = original.offsetWidth
      const signature = `${width}:${textWidth}:${reduced.matches}`
      if (signature === previous) return
      previous = signature
      stop?.(); stop = undefined
      const motion = !reduced.matches && marqueeMotion(width, textWidth, gap)
      setScrolling(Boolean(motion))
      if (motion) stop = animateMarquee(content, motion, pauseOnHover ? heading.closest<HTMLElement>('.mini-player') ?? heading : undefined)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(heading); observer.observe(original)
    const unsubscribe = subscribeMediaQuery(reduced, measure)
    document.addEventListener('visibilitychange', measure)
    window.addEventListener('pageshow', measure)
    window.addEventListener('focus', measure)
    void document.fonts.ready.then(measure)
    measure()
    return () => {
      disposed = true; stop?.(); observer.disconnect()
      unsubscribe()
      document.removeEventListener('visibilitychange', measure)
      window.removeEventListener('pageshow', measure)
      window.removeEventListener('focus', measure)
    }
  }, [viewport, track, copy, text, enabled, gap, pauseOnHover])
  return scrolling
}
