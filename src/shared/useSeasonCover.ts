import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getSeasonCover, parseSeasonReference, usableSeasonCover } from '../services/mediaSources'
import { accountQueryKey } from '../services/queryKeys'

export function useSeasonCover(reference?: string, cover?: string) {
  const ref = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const season = reference ? parseSeasonReference(reference) : null
  const missing = Boolean(season && !usableSeasonCover(cover))
  useEffect(() => {
    if (!missing || visible || !ref.current) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(true)
    }, { rootMargin: '100px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [missing, visible])
  const query = useQuery({
    queryKey: accountQueryKey('season-cover', reference),
    queryFn: () => getSeasonCover(season!),
    enabled: missing && visible,
    staleTime: 300_000,
    retry: false,
  })
  return { ref: missing ? ref : undefined, cover: missing ? query.data || undefined : cover }
}
