import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { accountEpoch } from './accountScope'
import { accountKeyAt } from './queryKeys'

type LinkedMatchedCover = { trackId: string; bvid: string; coverUrl: string; singlePart: boolean }
type LinkedMatchedCovers = { byVideo: ReadonlyMap<string, string>; byPart: ReadonlyMap<string, string> }

const emptyCovers: LinkedMatchedCovers = { byVideo: new Map(), byPart: new Map() }

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
      const byVideo = new Map<string, string>(), byPart = new Map<string, string>()
      for (const { trackId, bvid, coverUrl, singlePart } of covers) {
        byPart.set(trackId, coverUrl)
        if (singlePart) byVideo.set(bvid, coverUrl)
      }
      return { byVideo, byPart }
    },
  }).data ?? emptyCovers
}
