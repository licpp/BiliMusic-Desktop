import { useLayoutEffect, useState } from 'react'
import { subscribeMediaQuery } from './subscribeMediaQuery'

export function usePanelPresence(open: boolean, exitMs: number) {
  const [retained, setRetained] = useState(open)
  useLayoutEffect(() => {
    if (open) {
      setRetained(true)
      return
    }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (motion.matches) {
      setRetained(false)
      return
    }
    const finish = () => setRetained(false)
    const timer = window.setTimeout(finish, exitMs)
    const change = () => { if (motion.matches) finish() }
    const unsubscribe = subscribeMediaQuery(motion, change)
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [open, exitMs])
  return open || retained
}
