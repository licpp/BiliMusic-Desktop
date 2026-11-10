import { useEffect, useRef } from 'react'

export function LoadMore({ onLoad, busy, label, automatic = true }: {
  onLoad: () => void
  busy: boolean
  label: string
  automatic?: boolean
}) {
  const ref = useRef<HTMLButtonElement>(null)
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
  }, [])

  return <button ref={ref} className="load-more" disabled={busy} onClick={onLoad}>{busy ? '加载中…' : label}</button>
}
