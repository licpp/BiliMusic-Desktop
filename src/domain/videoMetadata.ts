import { withTrackTitle } from './sourceTitle'
import type {Track} from './track'
import type { BiliVideoPart, BiliVideoParts } from './bilibili'
import type {SeasonVideo,SeasonSummary} from './bilibili'
export function videoDetailFromTrack(track: Track, parts: BiliVideoPart[]): BiliVideoParts {
  return {
    chapterContext: track.chapterContext,
    season: track.sourceTitleContext?.season,
    playCount: track.playCount,
    publishedAt: track.publishedAt,
    bvid: track.source.bvid, aid: track.source.aid || 0, title: track.videoTitle || track.title,
    coverUrl: track.coverUrl || '', uploaderId: track.source.uploaderId || 0, uploaderName: track.source.uploaderName || '',
    parts: track.coverUrl ? parts.map(part => ({ ...part, coverUrl: part.coverUrl || track.coverUrl! })) : parts,
  }
}

export function seasonVideoRow(video: SeasonVideo, summary: SeasonSummary): Track {
  return withTrackTitle({
    id: `bilibili:${video.bvid}:${video.cid}`,
    source: { provider: 'bilibili', bvid: video.bvid, aid: video.aid, cid: video.cid, page: 1, uploaderId: summary.uploaderId, uploaderName: summary.uploaderName },
    chapterContext: true,
    sourceTitleContext: { videoTitle: video.title, partTitle: video.parts?.[0]?.title || video.title, partCount: video.parts?.length || 1, season: summary },
    title: video.title, videoTitle: video.title, coverUrl: video.coverUrl, durationSeconds: video.parts?.[0]?.durationSeconds ?? video.durationSeconds,
    publishedAt: video.publishedAt,
    liked: false, playCount: video.playCount, partCount: video.parts?.length, resolveParts: !video.parts?.length,
  })
}

