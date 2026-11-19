import type { SeasonSummary, SeasonVideo, Season } from '../domain/bilibili'
export type { SeasonSummary, SeasonVideo, Season } from '../domain/bilibili'
import { invoke } from '@tauri-apps/api/core'
import type { Track } from '../domain/track'
import { rememberVideoPages } from './videoPages'
import { toTrack } from './collectionTrack'
import { accountEpoch } from './accountScope'
import type { FavoriteVideo } from '../domain/bilibili'
import type { LyricLine } from '../domain/lyrics'
import type { Collection } from './collections'
export type QualityPreferences = { audioId:number; videoHeight:number }
export type MediaOptions = { audio:{id:number;label:string}[]; video:{id:number;label:string}[] }
export function seasonCollection(season: SeasonSummary): Collection {
  return {
    bvid: `season:${season.uploaderId}:${season.id}`,
    folderId: '',
    title: season.title,
    coverUrl: season.coverUrl,
    uploaderName: season.uploaderName,
  }
}
export function parseSeasonReference(reference:string) { const match=/^season:(\d+):(\d+)$/.exec(reference);return match ? {mid:Number(match[1]),seasonId:Number(match[2])} : null }
export async function getSeason(mid: number, seasonId: number, refresh = false) {
  const epoch = accountEpoch()
  const season = await invoke<Season>('bili_season', { mid, seasonId, refresh })
  if (epoch === accountEpoch()) for (const video of season.tracks) {
    if (video.parts) rememberVideoPages(video.bvid, video.parts)
  }
  return season
}

export {videoDetailFromTrack,seasonVideoRow} from '../domain/videoMetadata'
import { catalogVideoTrack, videoDetailFromTrack, seasonVideoRow } from '../domain/videoMetadata'

export function seasonTracks(season: Season): Track[] {
  let extra = 8000 - season.tracks.length
  return season.tracks.flatMap(video => {
    const row = seasonVideoRow(video, season.summary)
    if (!video.parts?.length) return [row]
    if (video.parts.length - 1 > extra) return [{ ...row, resolveParts: true }]
    extra -= video.parts.length - 1
    const detail = videoDetailFromTrack(row, video.parts)
    return video.parts.map(part => toTrack(detail, part))
  })
}
export const getSubtitles = (bvid:string,cid:number) => invoke<{language:string;label:string;ai:boolean}[]>('bili_subtitles',{bvid,cid})
export const getSubtitleLines = (bvid: string, cid: number, language: string) =>
  invoke<LyricLine[]>('bili_subtitle_lines', { bvid, cid, language })
export const getMediaOptions = (bvid:string,cid:number) => invoke<MediaOptions>('bili_media_options',{bvid,cid})
export const getMediaPreferences = () => invoke<QualityPreferences>('media_preferences')
export const setMediaPreferences = (value:Partial<QualityPreferences>) => invoke<QualityPreferences>('media_set_preferences',value)

export function creatorVideoRow(video: { bvid:string; aid:number; title:string; pic:string; length?:string; duration?:number; play?:number; created?:number; pubdate?:number }, mid: number, name: string): Track {
  const duration = video.length?.split(':').reduce((seconds,part)=>seconds*60 + Number(part),0)
  return catalogVideoTrack({publishedAt:video.pubdate || video.created,bvid:video.bvid,aid:video.aid,cid:0,title:video.title,coverUrl:video.pic,durationSeconds:Number.isFinite(duration) ? duration! : video.duration || 0,playCount:typeof video.play === 'number' && Number.isFinite(video.play) ? video.play : undefined}, mid, name)
}

export function favoriteVideoTrack(video: FavoriteVideo): Track {
  return catalogVideoTrack({
    bvid: video.bvid, aid: video.aid || 0, cid: 0, title: video.title, coverUrl: video.cover,
    durationSeconds: video.duration || 0, publishedAt: video.pubtime, playCount: video.cnt_info?.play,
  })
}
