import { useEffect, useState, type RefObject } from 'react'
import './highlight.css'

type Rect = { left: number; top: number; width: number; height: number }

/**
 * Reveals an entry that a settings preview just navigated to: the target is
 * scrolled into view and a ring on the top layer dims everything else, so the
 * guidance is never hidden under the dock or a scroll edge. The overlay never
 * captures pointer events.
 */
export function HighlightRing({ target, active }: { target: RefObject<HTMLElement | null>; active: boolean }) {
  const [rect, setRect] = useState<Rect | null>(null)
  useEffect(() => {
    if (!active) { setRect(null); return }
    const measure = () => {
      const node = target.current
      const box = node?.getBoundingClientRect()
      setRect(box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null)
    }
    target.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    measure()
    // The first frame after the stage switch can still move the target.
    const frame = requestAnimationFrame(measure)
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [active, target])
  if (!rect) return null
  return <div className="highlight-veil" aria-hidden="true">
    <div className="highlight-ring" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}/>
  </div>
}
