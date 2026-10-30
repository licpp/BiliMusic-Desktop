import type { Track } from '../domain/track'
import type { BiliVideoParts } from './desktopApi'
export function toTrack(detail: BiliVideoParts, part: BiliVideoParts['parts'][number]): Track {
  return { id: `bilibili:${detail.bvid}:${part.cid}`, source: { provider: 'bilibili', bvid: detail.bvid, aid: detail.aid, cid: part.cid, page: part.page, uploaderId: detail.uploaderId, uploaderName: detail.uploaderName }, title: part.title || detail.title, coverUrl: part.coverUrl || detail.coverUrl, durationSeconds: part.durationSeconds, liked: false }
}

