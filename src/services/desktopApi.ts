import { invoke, isTauri } from '@tauri-apps/api/core'
import type { Track } from '../domain/track'

export type BiliSearchItem = { bvid: string; title: string; uploaderName: string; uploaderId: number; coverUrl: string; durationSeconds: number; playCount: number; description: string }
export type BiliSearchPage = { items: BiliSearchItem[]; page: number; pageSize: number; total: number }
export type BiliVideoPart = { cid: number; page: number; title: string; durationSeconds: number; coverUrl: string }
export type BiliVideoParts = { bvid: string; aid: number; title: string; coverUrl: string; uploaderName: string; uploaderId: number; parts: BiliVideoPart[] }
export type PlaybackSource = { audioUrl: string; backupUrls: string[]; mimeType: string; codecs: string; bandwidth: number }
export type VideoSource = { videoUrl: string; mimeType: string; codecs: string; bandwidth: number }
export type DanmakuItem = { timeSeconds: number; mode: number; fontSize: number; color: number; text: string }
export type DesktopCommandError = { code: string; message: string; retryable: boolean }
export type StoredTrack = { id: string; bvid: string; aid?: number; cid: number; page: number; title: string; artist?: string; album?: string; coverUrl?: string; durationSeconds: number; uploaderId?: number; uploaderName?: string; liked: boolean }
export type MetadataPatch = { title: string; artist?: string; album?: string; coverUrl?: string }
export type LyricLine = { timeMs: number; text: string }
export type LyricCandidate = { id: number; trackName: string; artistName: string; albumName: string; duration: number; instrumental: boolean; plainLyrics?: string; syncedLyrics?: string }
export type StoredLyrics = { trackId: string; provider: string; providerLyricId: string; rawText: string; parsedJson: string; biasMs: number; selectedManually: boolean }
export type Playlist = { id: string; name: string; description: string; coverUrl?: string; trackCount: number }
export type CatalogCandidate = { trackId: number; trackName: string; artistName: string; collectionName?: string; artworkUrl?: string }
export type DownloadRecord = { id: string; trackId: string; targetPath: string; status: 'queued' | 'downloading' | 'completed' | 'failed'; receivedBytes: number; totalBytes?: number; errorMessage?: string }
export type QrLogin = { key: string; url: string }
export type QrLoginStatus = { status: 'waiting' | 'confirmed' | 'authenticated' | 'expired' | 'error'; message: string }
export type AccountProfile = { loggedIn: boolean; userId?: number; name?: string; avatarUrl?: string }
export type BiliComment = { id: number; rootId: number; parentId: number; userId: number; userName: string; avatarUrl: string; message: string; createdAt: number; likeCount: number; liked: boolean; replyCount: number; replies: BiliComment[] }
export type CommentPage = { items: BiliComment[]; next: number; isEnd: boolean; total: number }

export const inDesktopShell = isTauri()

export async function searchBilibili(keyword: string, page = 1): Promise<BiliSearchPage> {
  if (!inDesktopShell) return { items: [], page, pageSize: 20, total: 0 }
  return invoke<BiliSearchPage>('bili_search', { keyword, page, pageSize: 20 })
}

export const getVideoParts = (bvid: string) => invoke<BiliVideoParts>('bili_video_parts', { bvid })
export const getPlaybackSource = (bvid: string, cid: number) => invoke<PlaybackSource>('bili_playback_source', { bvid, cid })
export const getVideoSource = (bvid: string, cid: number) => invoke<VideoSource>('bili_video_source', { bvid, cid })
export const getDanmaku = (cid: number) => invoke<DanmakuItem[]>('bili_danmaku', { cid })

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

export async function listRecentTracks(): Promise<Track[]> {
  if (!inDesktopShell) return []
  return (await invoke<StoredTrack[]>('library_recent')).map(fromStoredTrack)
}

export async function listSearchHistory(): Promise<string[]> {
  if (!inDesktopShell) return []
  return invoke<string[]>('search_history_list')
}

export async function clearSearchHistory(): Promise<void> {
  if (!inDesktopShell) return
  await invoke('search_history_clear')
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

export async function listPlaylists(): Promise<Playlist[]> {
  if (!inDesktopShell) return []
  return invoke<Playlist[]>('playlists_list')
}
export const createPlaylist = (name: string) => invoke<Playlist>('playlist_create', { name })
export async function listPlaylistTracks(playlistId: string): Promise<Track[]> {
  if (!inDesktopShell) return []
  return (await invoke<StoredTrack[]>('playlist_tracks', { playlistId })).map(fromStoredTrack)
}
export const addTrackToPlaylist = (playlistId: string, trackId: string) => invoke<void>('playlist_add_track', { playlistId, trackId })
export const removeTrackFromPlaylist = (playlistId: string, trackId: string) => invoke<void>('playlist_remove_track', { playlistId, trackId })
export const deletePlaylist = (playlistId: string) => invoke<void>('playlist_delete', { playlistId })
export async function searchMetadataCatalog(title: string, artist: string): Promise<CatalogCandidate[]> {
  if (!inDesktopShell) return []
  return invoke<CatalogCandidate[]>('metadata_catalog_search', { title, artist })
}
export async function listDownloads(): Promise<DownloadRecord[]> {
  if (!inDesktopShell) return []
  return invoke<DownloadRecord[]>('downloads_list')
}
export const downloadTrack = (track: Track, targetDirectory: string) => invoke<void>('download_track', {
  trackId: track.id, bvid: track.source.bvid, cid: track.source.cid, title: track.title, targetDirectory,
})
export async function getAccountProfile(): Promise<AccountProfile> {
  if (!inDesktopShell) return { loggedIn: false }
  return invoke<AccountProfile>('bili_account_profile')
}
export const generateLoginQr = () => invoke<QrLogin>('bili_qr_login_generate')
export const pollLoginQr = (key: string) => invoke<QrLoginStatus>('bili_qr_login_poll', { key })
export const logoutBilibili = () => invoke<void>('bili_logout')
export const getComments = (aid: number, next = 1) => invoke<CommentPage>('bili_comments', { aid, next })
export const getCommentReplies = (aid: number, root: number, page = 1) => invoke<BiliComment[]>('bili_comment_replies', { aid, root, page })
export const setCommentLike = (aid: number, replyId: number, liked: boolean) => invoke<void>('bili_comment_like', { aid, replyId, liked })
export const replyComment = (aid: number, message: string, root?: number, parent?: number) => invoke<void>('bili_comment_reply', { aid, message, root, parent })

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
