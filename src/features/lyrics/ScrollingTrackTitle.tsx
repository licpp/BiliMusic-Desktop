import { useEffect, useRef, useState } from 'react'

// Both moving sections use the same speed. The first ends with the last word
// visible; the second brings in an identical copy for a seamless next cycle.
export function trackTitleMotion(viewport: number, text: number) {
  if (!Number.isFinite(viewport) || !Number.isFinite(text) || viewport <= 0 || text <= viewport + 1) return null
  const gap = 32, speed = 28, startHold = 1600, endHold = 1100
  const overflow = text - viewport, distance = text + gap
  const endAt = startHold + overflow / speed * 1000
  const duration = startHold + endHold + distance / speed * 1000
  return { duration, keyframes: [
    { transform: 'translateX(0px)', offset: 0 },
    { transform: 'translateX(0px)', offset: startHold / duration },
    { transform: `translateX(${-overflow}px)`, offset: endAt / duration },
    { transform: `translateX(${-overflow}px)`, offset: (endAt + endHold) / duration },
    { transform: `translateX(${-distance}px)`, offset: 1 },
  ] }
}

export function ScrollingTrackTitle({ text, enabled }: { text: string; enabled: boolean }) {
  const viewport = useRef<HTMLHeadingElement>(null), track = useRef<HTMLSpanElement>(null), copy = useRef<HTMLSpanElement>(null)
  const [scrolling, setScrolling] = useState(false)
  useEffect(() => {
    const heading = viewport.current, content = track.current, original = copy.current
    if (!heading || !content || !original || !enabled) { setScrolling(false); return }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let animation: Animation | undefined, previous = '', disposed = false
    const measure = () => {
      if (disposed) return
      const width = heading.clientWidth, textWidth = original.offsetWidth
      const signature = `${width}:${textWidth}:${reduced.matches}`
      if (signature === previous) return
      previous = signature
      animation?.cancel(); animation = undefined
      const motion = !reduced.matches && trackTitleMotion(width, textWidth)
      const active = Boolean(motion && typeof content.animate === 'function')
      setScrolling(active)
      if (motion && active) {
        animation = content.animate(motion.keyframes, { duration: motion.duration, iterations: Infinity, easing: 'linear' })
        if (document.hidden) animation.pause()
      }
    }
    const visibility = () => { if (document.hidden) animation?.pause(); else animation?.play() }
    const observer = new ResizeObserver(measure)
    observer.observe(heading); observer.observe(original)
    reduced.addEventListener('change', measure)
    document.addEventListener('visibilitychange', visibility)
    void document.fonts.ready.then(measure)
    measure()
    return () => {
      disposed = true; animation?.cancel(); observer.disconnect()
      reduced.removeEventListener('change', measure)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [text, enabled])
  return <h1 ref={viewport} className="lyrics-track-title" title={text} data-scrolling={scrolling || undefined}>
    <span ref={track} className="lyrics-title-track"><span ref={copy}>{text}</span><span className="lyrics-title-repeat" aria-hidden="true">{text}</span></span>
  </h1>
}
