import { accountEpoch } from '../../services/accountScope'
import { getVideoParts } from '../../services/desktopApi'
import { toTrack } from '../../services/collectionTrack'
import { biliRequestPause } from '../../services/biliRequestStatus'
import type { Track } from '../../domain/track'

export async function resolveLinkedSelection(selected: Track[], current: () => boolean) {
  const tracks: Track[] = []
  let failed = 0
  const account = accountEpoch()
  for (const video of selected) {
    if (account !== accountEpoch() || !current()) return
    if (video.sourceExpired) { failed++; continue }
    if (!video.resolveParts && video.source.cid > 0) {
      tracks.push(video)
      continue
    }
    try {
      const detail = await getVideoParts(video.source.bvid)
      const parts = detail.parts.filter(part => part.cid > 0).map(part => toTrack(detail, part))
      if (parts.length) tracks.push(...parts)
      else failed++
    } catch (error) {
      if (biliRequestPause(error)) throw error
      failed++
    }
  }
  if (account === accountEpoch() && current()) return { tracks, failed }
}
