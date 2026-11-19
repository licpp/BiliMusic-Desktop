import { accountEpoch } from '../../services/accountScope'
import { getVideoParts } from '../../services/desktopApi'
import { toTrack } from '../../services/collectionTrack'
import type { Track } from '../../domain/track'

export async function resolveLinkedSelection(selected: Track[], current: () => boolean) {
  const tracks: Track[][] = []
  const failures: string[] = []
  const account = accountEpoch()
  for (const video of selected) {
    if (account !== accountEpoch() || !current()) return
    try {
      const detail = await getVideoParts(video.source.bvid)
      const parts = detail.parts.filter(part => part.cid > 0).map(part => toTrack(detail, part))
      if (parts.length) tracks.push(parts)
      else failures.push(video.title)
    } catch { failures.push(video.title) }
  }
  if (account === accountEpoch() && current()) return { tracks: tracks.flat(), failed: failures.length }
}
