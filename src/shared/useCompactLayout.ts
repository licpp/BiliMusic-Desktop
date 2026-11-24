import { useEffect, useState } from 'react'
import { isLargeScreen } from '../services/platform'
import { subscribeMediaQuery } from './subscribeMediaQuery'

export function useCompactLayout() {
  return useLayoutWidth('(max-width: 960px)', !isLargeScreen)
}

export function useTabletWidth() {
  return useLayoutWidth('(min-width: 640px)')
}

function useLayoutWidth(media: string, enabled = true) {
  const [matches, setMatches] = useState(() => enabled && window.matchMedia(media).matches)
  useEffect(() => {
    if (!enabled) return
    const query = window.matchMedia(media)
    const update = () => setMatches(query.matches)
    const unsubscribe = subscribeMediaQuery(query, update)
    update()
    return unsubscribe
  }, [media, enabled])
  return enabled && matches
}
