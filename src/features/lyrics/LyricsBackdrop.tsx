import { memo, useEffect, useRef, useState } from 'react'

export const LyricsBackdrop = memo(function LyricsBackdrop({ cover, className = '' }: { cover?: string; className?: string }) {
  const container = useRef<HTMLDivElement>(null)
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
  return <div ref={container} className={`lyrics-backdrop ${className}`} aria-hidden="true">{src && src !== failed && <img key={src} className={ready === src ? 'ready' : ''} src={src} referrerPolicy="no-referrer" alt="" onLoad={() => setReady(src)} onError={() => setFailed(src)} style={{ transform: `translate(-50%,-50%) scale(${scale})` }} />}</div>
})
