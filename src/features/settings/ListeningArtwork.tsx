import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Artwork } from '../../shared/Artwork'
import { getListeningArtwork } from '../../services/listeningArtwork'
import { accountEpoch } from '../../services/accountScope'

export function ListeningArtwork({ id, coverUrl }: { id: string; coverUrl: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false), [failed, setFailed] = useState<string>()
  useEffect(() => {
    if (!ref.current) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '100px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  const missing = !coverUrl?.trim() || failed === coverUrl
  const query = useQuery({ queryKey: ['listening-artwork', accountEpoch(), id], queryFn: async () => (await getListeningArtwork(id)) || null,
    enabled: visible && missing, staleTime: 10 * 60_000, retry: false })
  return <Artwork key={query.dataUpdatedAt} elementRef={ref} src={missing && query.data ? query.data : coverUrl}
    onError={() => setFailed(coverUrl)} />
}
