import { invoke } from '@tauri-apps/api/core'
import type { Track } from '../domain/track'
import { rememberVideoPages } from './videoPages'
import { toTrack } from './collectionTrack'
import { accountEpoch } from './accountScope'
import type { BiliVideoPart, BiliVideoParts, LyricLine } from './desktopApi'
import type { Collection } from './collections'
export type SeasonSummary = { id:number; uploaderId:number; title:string; coverUrl:string; uploaderName:string }
export type SeasonVideo = { bvid: string; aid: number; cid: number; title: string; coverUrl: string; durationSeconds: number; parts?: BiliVideoPart[] }
export type Season = { unavailable: number; summary: SeasonSummary; tracks: SeasonVideo[] }
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

export function videoDetailFromTrack(track: Track, parts: BiliVideoPart[]): BiliVideoParts {
  return {
    bvid: track.source.bvid, aid: track.source.aid || 0, title: track.videoTitle || track.title,
    coverUrl: track.coverUrl || '', uploaderId: track.source.uploaderId || 0, uploaderName: track.source.uploaderName || '',
    parts: track.coverUrl ? parts.map(part => ({ ...part, coverUrl: track.coverUrl! })) : parts,
  }
}

export function seasonVideoRow(video: SeasonVideo, summary: SeasonSummary): Track {
  return {
    id: `bilibili:${video.bvid}:${video.cid}`,
    source: { provider: 'bilibili', bvid: video.bvid, aid: video.aid, cid: video.cid, page: 1, uploaderId: summary.uploaderId, uploaderName: summary.uploaderName },
    title: video.title, videoTitle: video.title, coverUrl: video.coverUrl, durationSeconds: video.parts?.[0]?.durationSeconds ?? video.durationSeconds,
    liked: false, partCount: video.parts?.length, resolveParts: !video.parts?.length,
  }
}

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
