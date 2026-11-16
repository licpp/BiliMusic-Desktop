import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Track } from '../domain/track'
import { accountEpoch } from '../services/accountScope'
import { getVideoParts } from '../services/desktopApi'
import { hydrateSourceTitles } from '../services/sourceTitles'

/** Source details are public cache data; apply them through the guarded stored
 * read so a late response can never overwrite a newer manual title. */
export function useSourceTitleMetadata(track: Track | null) {
  const client = useQueryClient(), bvid = track?.source.bvid || ''
  const detail = useQuery({ queryKey: ['video-detail', accountEpoch(), bvid], queryFn: () => getVideoParts(bvid),
    enabled: Boolean(bvid), staleTime: 5 * 60_000, retry: false }).data
  useEffect(() => { if (detail && track?.id) void hydrateSourceTitles([track.id], client, true) }, [detail, track?.id, client])
  return detail
}
