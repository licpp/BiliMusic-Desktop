import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { accountEpoch } from './accountScope'
import { accountKeyAt } from './queryKeys'
import type { Track } from '../domain/track'

export type LinkedTrackOverrides = { coverUrl?: string; title?: string | null; artist?: string | null; album?: string | null }
type LinkedMatchedCover = LinkedTrackOverrides & { trackId: string; bvid: string; singlePart: boolean }
type LinkedMatchedCovers = { byVideo: ReadonlyMap<string, LinkedTrackOverrides>; byPart: ReadonlyMap<string, LinkedTrackOverrides> }

const emptyCovers: LinkedMatchedCovers = { byVideo: new Map(), byPart: new Map() }

export function applyLinkedTrackOverrides(track: Track, overrides?: LinkedTrackOverrides): Track {
  if (!overrides) return track
  const { title, artist, album, coverUrl } = overrides
  return { ...track, title: title || track.title, displayTitle: title || track.displayTitle,
    titleOverridden: Boolean(title) || track.titleOverridden, artist: artist ?? track.artist,
    album: album ?? track.album, coverUrl: coverUrl || track.coverUrl }
}

export function useLinkedMatchedCovers(bvids: readonly string[]): LinkedMatchedCovers {
  const ids = useMemo(() => [...new Set(bvids)].sort(), [bvids])
  const epoch = accountEpoch()
  return useQuery({
    queryKey: accountKeyAt(epoch, 'library', 'linked-matched-covers', ids),
    enabled: ids.length > 0 && isTauri(),
    queryFn: async ({ signal }) => {
      const expectedAccountSession = await invoke<string>('account_session')
      if (signal.aborted || epoch !== accountEpoch()) return emptyCovers
      const covers = await invoke<LinkedMatchedCover[]>('bili_linked_matched_covers', { bvids: ids, expectedAccountSession })
      if (signal.aborted || epoch !== accountEpoch()) return emptyCovers
      const byVideo = new Map<string, LinkedTrackOverrides>(), byPart = new Map<string, LinkedTrackOverrides>()
      for (const { trackId, bvid, singlePart, ...overrides } of covers) {
        byPart.set(trackId, overrides)
        if (singlePart) byVideo.set(bvid, overrides)
      }
      return { byVideo, byPart }
    },
  }).data ?? emptyCovers
}
