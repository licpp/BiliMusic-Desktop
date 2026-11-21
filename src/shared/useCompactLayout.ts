import { useEffect, useState } from 'react'
import { isLargeScreen } from '../services/platform'
export function useCompactLayout() {
  return useLayoutWidth('(max-width: 960px)') && !isLargeScreen
}

export function useTabletWidth() {
  return useLayoutWidth('(min-width: 640px)')
}

function useLayoutWidth(media: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(media).matches)
  useEffect(() => {
    const query = window.matchMedia(media)
    const update = () => setMatches(query.matches)
    query.addEventListener('change', update)
    update()
    return () => query.removeEventListener('change', update)
  }, [media])
  return matches
}
