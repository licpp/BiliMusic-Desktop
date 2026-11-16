import { withTrackTitle, sourceTitle } from '../domain/sourceTitle'
import type { Track } from '../domain/track'
import type { BiliVideoParts } from '../domain/bilibili'

export function toTrack(detail: BiliVideoParts, part: BiliVideoParts['parts'][number]): Track {
  return withTrackTitle({
    id: `bilibili:${detail.bvid}:${part.cid}`,
    source: { provider: 'bilibili', bvid: detail.bvid, aid: detail.aid || undefined, cid: part.cid, page: part.page, uploaderId: detail.uploaderId, uploaderName: detail.uploaderName },
    title: sourceTitle(detail.title, part.title, detail.parts.length, Boolean(detail.season || detail.chapterContext)),
    displayTitle: sourceTitle(detail.title, part.title, detail.parts.length, Boolean(detail.season || detail.chapterContext)),
    videoTitle: detail.title,
    sourceTitleContext: { videoTitle: detail.title, partTitle: part.title, partCount: detail.parts.length, season: detail.season, chapterContext: detail.chapterContext },
    publishedAt: detail.publishedAt,
    playCount: detail.playCount,
    partCount: detail.parts.length,
    chapterContext: Boolean(detail.season || detail.chapterContext),
    coverUrl: part.coverUrl || detail.coverUrl,
    durationSeconds: part.durationSeconds,
    liked: false,
  })
}
