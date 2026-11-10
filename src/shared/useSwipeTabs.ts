import { useEffect, useRef } from 'react'

export function useSwipeTabs<T extends string>(tabs: readonly T[], active: T, change: (tab: T) => void) {
  const element = useRef<HTMLDivElement>(null)
  const current = useRef({ tabs, active, change })
  current.current = { tabs, active, change }
  useEffect(() => {
    const panel = element.current
    const swipe = (event: Event) => {
      const { tabs, active, change } = current.current
      const next = tabs[tabs.indexOf(active) + (event as CustomEvent<number>).detail]
      if (next) change(next)
    }
    panel?.addEventListener('bilimusic-tab-swipe', swipe)
    return () => panel?.removeEventListener('bilimusic-tab-swipe', swipe)
  }, [])
  return element
}
