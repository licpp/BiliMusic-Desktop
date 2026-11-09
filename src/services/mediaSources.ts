import { invoke } from '@tauri-apps/api/core'
import type { Track } from '../domain/track'
import type { LyricLine } from './desktopApi'
export type SeasonSummary = { id:number; uploaderId:number; title:string; coverUrl:string; uploaderName:string }
export type Season = { unavailable:number; summary:SeasonSummary; tracks:{bvid:string; aid:number; cid:number; title:string; coverUrl:string; durationSeconds:number}[] }
export type QualityPreferences = { audioId:number; videoHeight:number }
export type MediaOptions = { audio:{id:number;label:string}[]; video:{id:number;label:string}[] }
export const seasonReference = (season:SeasonSummary) => `season:${season.uploaderId}:${season.id}`
export function parseSeasonReference(reference:string) { const match=/^season:(\d+):(\d+)$/.exec(reference);return match ? {mid:Number(match[1]),seasonId:Number(match[2])} : null }
export const getSeason = (mid:number,seasonId:number) => invoke<Season>('bili_season',{mid,seasonId})
export function seasonTracks(season:Season):Track[] { return season.tracks.map(t=>({id:`bilibili:${t.bvid}:${t.cid}`,source:{provider:'bilibili',bvid:t.bvid,aid:t.aid,cid:t.cid,page:1,uploaderId:season.summary.uploaderId,uploaderName:season.summary.uploaderName},title:t.title,coverUrl:t.coverUrl,durationSeconds:t.durationSeconds,liked:false})) }
export const getSubtitles = (bvid:string,cid:number) => invoke<{language:string;label:string;ai:boolean}[]>('bili_subtitles',{bvid,cid})
export const getSubtitleLines = (bvid: string, cid: number, language: string) =>
  invoke<LyricLine[]>('bili_subtitle_lines', { bvid, cid, language })
export const getMediaOptions = (bvid:string,cid:number) => invoke<MediaOptions>('bili_media_options',{bvid,cid})
export const getMediaPreferences = () => invoke<QualityPreferences>('media_preferences')
export const setMediaPreferences = (value:Partial<QualityPreferences>) => invoke<QualityPreferences>('media_set_preferences',value)
