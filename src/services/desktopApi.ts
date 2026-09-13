import { invoke, isTauri } from '@tauri-apps/api/core'
import type { Track } from '../domain/track'

export type BiliSearchItem = { bvid: string; title: string; uploaderName: string; uploaderId: number; coverUrl: string; durationSeconds: number; playCount: number; description: string }
export type BiliSearchPage = { items: BiliSearchItem[]; page: number; pageSize: number; total: number }
export type BiliVideoPart = { cid: number; page: number; title: string; durationSeconds: number; coverUrl: string }
export type BiliVideoParts = { bvid: string; aid: number; title: string; coverUrl: string; uploaderName: string; uploaderId: number; parts: BiliVideoPart[] }
export type PlaybackSource = { audioUrl: string; backupUrls: string[]; mimeType: string; codecs: string; bandwidth: number }
export type DesktopCommandError = { code: string; message: string; retryable: boolean }
export type StoredTrack = { id: string; bvid: string; aid?: number; cid: number; page: number; title: string; artist?: string; album?: string; coverUrl?: string; durationSeconds: number; uploaderId?: number; uploaderName?: string; liked: boolean }
export type MetadataPatch = { title: string; artist?: string; album?: string; coverUrl?: string }
export type LyricLine = { timeMs: number; text: string }
export type LyricCandidate = { id: number; trackName: string; artistName: string; albumName: string; duration: number; instrumental: boolean; plainLyrics?: string; syncedLyrics?: string }
export type StoredLyrics = { trackId: string; provider: string; providerLyricId: string; rawText: string; parsedJson: string; biasMs: number; selectedManually: boolean }

export const inDesktopShell = isTauri()

export async function searchBilibili(keyword: string, page = 1): Promise<BiliSearchPage> {
  if (!inDesktopShell) return { items: [], page, pageSize: 20, total: 0 }
  return invoke<BiliSearchPage>('bili_search', { keyword, page, pageSize: 20 })
}

export const getVideoParts = (bvid: string) => invoke<BiliVideoParts>('bili_video_parts', { bvid })
export const getPlaybackSource = (bvid: string, cid: number) => invoke<PlaybackSource>('bili_playback_source', { bvid, cid })

export async function recordPlayedTrack(track: Track): Promise<Track> {
  if (!inDesktopShell) return track
  const stored = await invoke<StoredTrack>('library_record_play', { track: toTrackInput(track) })
  return fromStoredTrack(stored)
}

export async function listLibraryTracks(favoritesOnly = false): Promise<Track[]> {
  if (!inDesktopShell) return []
  const tracks = await invoke<StoredTrack[]>('library_tracks', { favoritesOnly })
  return tracks.map(fromStoredTrack)
}

export const toggleStoredFavorite = (trackId: string) => invoke<boolean>('library_toggle_favorite', { trackId })
export async function updateStoredMetadata(trackId: string, patch: MetadataPatch): Promise<Track> {
  return fromStoredTrack(await invoke<StoredTrack>('library_update_metadata', { trackId, patch }))
}

export async function searchLyrics(title: string, artist?: string): Promise<LyricCandidate[]> {
  if (!inDesktopShell) return []
  return invoke<LyricCandidate[]>('lyrics_search', { title, artist })
}

export async function getStoredLyrics(trackId: string): Promise<StoredLyrics | null> {
  if (!inDesktopShell) return null
  return invoke<StoredLyrics | null>('lyrics_get', { trackId })
}

export async function saveStoredLyrics(trackId: string, candidate: LyricCandidate, lines: LyricLine[], manual: boolean): Promise<StoredLyrics> {
  return invoke<StoredLyrics>('lyrics_save', {
    trackId,
    lyrics: {
      providerLyricId: String(candidate.id),
      rawText: candidate.syncedLyrics || candidate.plainLyrics || '',
      parsedJson: JSON.stringify(lines),
    },
    manual,
  })
}

export const setStoredLyricsBias = (trackId: string, biasMs: number) =>
  invoke<StoredLyrics>('lyrics_set_bias', { trackId, biasMs })

function toTrackInput(track: Track) {
  return {
    id: track.id, bvid: track.source.bvid, aid: track.source.aid, cid: track.source.cid, page: track.source.page,
    sourceTitle: track.title, title: track.title, artist: track.artist, album: track.album, coverUrl: track.coverUrl,
    durationSeconds: track.durationSeconds, uploaderId: track.source.uploaderId, uploaderName: track.source.uploaderName,
  }
}

function fromStoredTrack(track: StoredTrack): Track {
  return { id: track.id, source: { provider: 'bilibili', bvid: track.bvid, aid: track.aid, cid: track.cid, page: track.page, uploaderId: track.uploaderId, uploaderName: track.uploaderName }, title: track.title, artist: track.artist, album: track.album, coverUrl: track.coverUrl, durationSeconds: track.durationSeconds, liked: track.liked }
}

export function commandErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as DesktopCommandError).message)
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}
