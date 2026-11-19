import { useLayoutEffect, useState } from 'react'

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
    motion.addEventListener('change', change)
    return () => {
      window.clearTimeout(timer)
      motion.removeEventListener('change', change)
    }
  }, [open, exitMs])
  return open || retained
}
