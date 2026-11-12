import { useEffect, useRef } from 'react'

export function LoadMore({ onLoad, busy, label, automatic = true, presentation = 'button' }: {
  onLoad: () => void
  busy: boolean
  label: string
  automatic?: boolean
  presentation?: 'button' | 'status'
}) {
  const ref = useRef<HTMLElement | null>(null)
  const state = useRef({ onLoad, busy, automatic })
  state.current = { onLoad, busy, automatic }

  useEffect(() => {
    if (!ref.current) return
    let triggered = false
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) { triggered = false; return }
      const current = state.current
      if (triggered || !current.automatic || current.busy) return
      triggered = true
      current.onLoad()
    }, { threshold: 0.25 })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [busy, automatic, presentation])

  if(presentation==='status')return <div ref={node=>{ref.current=node}} className="load-more-status" role="status">{busy?'加载中…':label}</div>
  return <button ref={node=>{ref.current=node}} className="load-more" disabled={busy} onClick={onLoad}>{busy ? '加载中…' : label}</button>
}
