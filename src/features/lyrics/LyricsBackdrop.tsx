import { memo, useEffect, useRef, useState } from 'react'
import { usePanelReveal } from '../../shared/usePanelReveal'

export const LyricsBackdrop = memo(function LyricsBackdrop({ cover, className = '', open = true }: { cover?: string; className?: string; open?: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  usePanelReveal(container, open)
  const [scale, setScale] = useState(8)
  const [ready, setReady] = useState('')
  const [failed, setFailed] = useState('')
  const src = cover?.replace(/^http:\/\//, 'https://') || ''
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setScale(Math.max(entry.contentRect.width, entry.contentRect.height) / 256 * 1.4))
    if (container.current) observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  // Blur a small static image, then composite it at page size. No per-frame sampling
  // or backdrop-filter on scrolling lyrics, so the background can stay cached.
  return <div ref={container} className={`lyrics-backdrop ${className}`} aria-hidden="true">{[ready, src !== ready && src !== failed ? src : ''].filter(Boolean).map(url =>
    <img key={url} className={ready === url ? 'ready' : ''} src={url} referrerPolicy="no-referrer" alt=""
      onLoad={() => { if (url === src) setReady(url) }} onError={() => { if (url === src) setFailed(url) }}
      style={{ transform: `translate(-50%,-50%) scale(${scale})` }} />)}</div>
})
