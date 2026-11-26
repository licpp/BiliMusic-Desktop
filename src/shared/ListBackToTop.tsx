import { ArrowUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function ListBackToTop() {
  const marker = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState<{ right: number; bottom: number }>()
  useEffect(() => {
    const host = marker.current?.closest<HTMLElement>('.stage-scroll,.mobile-page-content,.large-main')
    if (!host) return
    const update = () => {
      const rect = host.getBoundingClientRect()
      if (host.scrollTop < host.clientHeight || !rect.width || !rect.height) {
        setPosition(previous => previous ? undefined : previous)
        return
      }
      const right = Math.max(12, window.innerWidth - rect.right + 16)
      const bottom = Math.max(12, window.innerHeight - rect.bottom + 16)
      setPosition(previous => previous?.right === right && previous.bottom === bottom ? previous : { right, bottom })
    }
    host.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(host)
    update()
    return () => { observer.disconnect(); host.removeEventListener('scroll', update) }
  }, [])
  return <><span hidden ref={marker}/>{position && createPortal(<button type="button" className="playlist-back-top icon-action" style={position}
    aria-label="回到顶部" title="回到顶部" onClick={() => {
      const host = marker.current?.closest<HTMLElement>('.stage-scroll,.mobile-page-content,.large-main')
      if (!host) return
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) host.scrollTop = 0
      else host.scrollTo({ top: 0, behavior: 'smooth' })
    }}><ArrowUp size={20}/></button>, document.body)}</>
}
