import type { BiliVideoParts } from '../domain/bilibili'
import type { Track } from '../domain/track'
import { toTrack } from '../services/collectionTrack'

export async function resolveLargeVideoEntry(read: () => Promise<BiliVideoParts>, track?: Track) {
  if (track?.partCount === 1 && !track.resolveParts && track.source.cid > 0) {
    return { kind: 'single' as const, track }
  }
  if ((track?.partCount ?? 0) > 1) return { kind: 'parts' as const }
  const detail = await read()
  if (detail.parts.length > 1) return { kind: 'parts' as const }
  const part = detail.parts[0]
  if (!part) throw new Error('暂无可播放内容')
  return { kind: 'single' as const, track: toTrack(detail, part) }
}
