import { trackHidden, videoScope, type VisibilityRule } from '../../domain/contentVisibility'
import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { toTrack } from '../../services/collectionTrack'
import { ensureVisibility, useContentVisibility } from '../../services/contentVisibility'
import { getVideoParts } from '../../services/desktopApi'

export function downloadableSelection(tracks: readonly Track[], rules: readonly VisibilityRule[], scope?: string) {
  return tracks.filter(track => track.source.provider === 'bilibili' && !track.resolveParts && track.source.cid > 0 &&
    !trackHidden(track, scope ?? videoScope(track.source.bvid), rules))
}

export async function prepareDownloadSelection(tracks: readonly Track[], scope?: string, current = () => true) {
  const account = accountEpoch()
  const active = () => account === accountEpoch() && current()
  await ensureVisibility()
  const expanded: Track[] = []
  let failed = 0
  const rules = () => useContentVisibility.getState().rules
  for (const track of tracks) {
    if (!active()) return
    if (track.source.provider !== 'bilibili' || trackHidden(track, scope ?? videoScope(track.source.bvid), rules())) continue
    if (track.resolveParts || track.source.cid <= 0) {
      try {
        const detail = await getVideoParts(track.source.bvid)
        const parts = detail.parts.filter(part => part.cid > 0)
        if (parts.length) expanded.push(...parts.map(part => toTrack(detail, part)))
        else failed++
      } catch {
        failed++
      }
    } else {
      expanded.push(track)
    }
  }
  if (active()) return { tracks: downloadableSelection(expanded, rules(), scope), failed }
}

export function downloadSelectionMessage(failed: number, count: number) {
  if (failed) return `${failed} 个视频未能读取可用分 P`
  if (!count) return '没有可下载的分 P'
  return ''
}
