import { useRef } from 'react'
import { useMarquee } from '../../shared/useMarquee'

export function ScrollingTrackTitle({ text, enabled }: { text: string; enabled: boolean }) {
  const viewport = useRef<HTMLHeadingElement>(null), track = useRef<HTMLSpanElement>(null), copy = useRef<HTMLSpanElement>(null)
  const scrolling = useMarquee(viewport, track, copy, text, enabled)
  return <h1 ref={viewport} className="lyrics-track-title" title={text} data-scrolling={scrolling || undefined}>
    <span ref={track} className="lyrics-title-track"><span ref={copy}>{text}</span><span className="lyrics-title-repeat" aria-hidden="true">{text}</span></span>
  </h1>
}
