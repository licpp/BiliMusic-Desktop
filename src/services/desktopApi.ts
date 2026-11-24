import type { DiagnosticSource } from './diagnostics'
import { withTrackTitle } from '../domain/sourceTitle'
import { sourceTrack } from '../domain/importedPresentation'
import type { ImportedEntriesSnapshot } from '../domain/importedEntry'
import type { BiliComment, CommentPage } from '../domain/comments'
export type { BiliComment, CommentPage } from '../domain/comments'
import type { QrLogin, QrLoginStatus, AccountProfile } from '../domain/account'
export type { QrLogin, QrLoginStatus, AccountProfile } from '../domain/account'
import type { DownloadRecord } from '../domain/downloads'
export type { DownloadRecord } from '../domain/downloads'
import type { StoredTrack, MetadataPatch, Playlist, CatalogSource, CatalogCandidate } from '../domain/library'
export type { StoredTrack, MetadataPatch, Playlist, CatalogSource, CatalogCandidate } from '../domain/library'
import type { LyricWord, LyricLine, LyricCandidate, LyricSearchResult, StoredLyrics } from '../domain/lyrics'
import { LyricBiasConflict } from '../domain/lyrics'
export type { LyricWord, LyricLine, LyricCandidate, LyricSearchResult, StoredLyrics } from '../domain/lyrics'
import type { BiliSearchItem, BiliSearchPage, BiliVideoPart, BiliVideoParts, PlaybackSource, VideoSource, DanmakuItem, FavoriteFolder, FavoriteVideo, FavoritePage, LinkedFolder } from '../domain/bilibili'
export type { BiliSearchItem, BiliSearchPage, BiliVideoPart, BiliVideoParts, PlaybackSource, VideoSource, DanmakuItem, FavoriteFolder, FavoriteVideo, FavoritePage, LinkedFolder } from '../domain/bilibili'
import { accountEpoch } from './accountScope'
import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import { getVideoParts } from './videoPages'
export { getVideoParts } from './videoPages'
import { toTrack } from './collectionTrack'
import type { Track } from '../domain/track'
import { attachSupplementalLyrics, candidateLines } from '../domain/lrc'
import { rankCatalogCandidates, rankLyricCandidates } from './musicMatchRanking'
import { lookupSongs } from './songLookup'

export type DesktopCommandError = { code: string; message: string; retryable: boolean }
export const FAVORITES_PLAYLIST_ID = 'system:favorites'
export const FAVORITES_PLAYLIST: Playlist = { id: FAVORITES_PLAYLIST_ID, name: '我喜欢', description: '点击红心收藏的歌曲 · 默认歌单', trackCount: 0, isSystem: true }

export const inDesktopShell = isTauri()
const scopedCommands = new Set('library_save_track library_update_metadata library_toggle_favorite lyrics_save lyrics_save_with_metadata lyric_match_version lyrics_set_bias playlist_create playlist_add_track playlist_add_tracks playlist_remove_track playlist_remove_tracks playlist_delete playlist_rename bili_linked_folder bili_linked_refresh bili_linked_change bili_linked_remove_selected'.split(' '))
async function scopedInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const epoch = accountEpoch()
  const expectedAccountSession = scopedCommands.has(command) ? await invoke<string>('account_session') : undefined
  if (epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED')
  const value = await invoke<T>(command, {...args, ...(expectedAccountSession ? {expectedAccountSession} : {})})
  if (epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED')
  return value
}
async function write<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const value = await scopedInvoke<T>(command, args)
  if (command === 'lyrics_save') window.dispatchEvent(new CustomEvent('bilimusic-lyrics-updated',{detail:value}))
  window.dispatchEvent(new Event('bilimusic-data-changed'))
  return value
}

export async function searchBilibili(keyword: string, page = 1): Promise<BiliSearchPage> {
  if (!inDesktopShell) return { items: [], page, pageSize: 20, total: 0 }
  return invoke<BiliSearchPage>('bili_search', { keyword, page, pageSize: 20 })
}

export async function getSearchSuggestions(keyword: string): Promise<string[]> {
  if (!inDesktopShell) return []
  return invoke<string[]>('bili_search_suggestions', { keyword })
}

export const getPlaybackSource = (bvid: string, cid: number) => invoke<PlaybackSource>('bili_playback_source', { bvid, cid })
export const getTrackPlaybackUrl = (track: Track, refresh = false, preferOnline = false) => invoke<string>('track_playback_url', { trackId: track.id, refresh, preferOnline })
export const getTrackPlaybackPlan = (track: Track, refresh = false, preferOnline = false, offlineOnly = false) => invoke<{ url: string; upgradeUrl?: string; loudnessGainDb?: number; source?: DiagnosticSource; requestedQuality?: number; actualQuality?: number; codec?: string }>('track_playback_plan', { trackId: track.id, refresh, preferOnline, ...(offlineOnly ? { offlineOnly } : {}) })
export async function saveLibraryTrack(track: Track): Promise<Track> {
  if (!inDesktopShell) return track
  if (track.resolveParts && track.source.cid <= 0) {
    const epoch = accountEpoch()
    const detail = await getVideoParts(track.source.bvid)
    if (epoch !== accountEpoch()) throw new Error('账号已切换')
    if (!detail.parts[0]) throw new Error('暂无可播放内容')
    track = toTrack(detail, detail.parts[0])
  }
  return fromStoredTrack(await scopedInvoke<StoredTrack>('library_save_track', { track: toTrackInput(track) }))
}
export const getVideoSource = (bvid: string, cid: number, refresh = false, compatible = false) => invoke<VideoSource>('bili_video_source', { bvid, cid, refresh, compatible })
export const getDanmaku = (cid: number) => invoke<DanmakuItem[]>('bili_danmaku', { cid })

export async function recordPlayedTrack(track: Track): Promise<Track> {
  if (!inDesktopShell) return track
  const stored = await write<StoredTrack>('library_record_play', { track: toTrackInput(track) })
  window.dispatchEvent(new Event('bilimusic-recent-changed'))
  return withTrackTitle({ ...sourceTrack(track), ...fromStoredTrack(stored), sourceTitleContext: stored.sourceTitleContext || track.sourceTitleContext, videoTitle: stored.sourceVideoTitle || track.videoTitle, partCount: track.partCount })
}

export async function listLibraryTracks(favoritesOnly = false, savedOnly = false): Promise<Track[]> {
  if (!inDesktopShell) return []
  const tracks = await invoke<StoredTrack[]>('library_tracks', { favoritesOnly, savedOnly })
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

export const toggleStoredFavorite = (trackId: string) => write<boolean>('library_toggle_favorite', { trackId })
export async function updateStoredMetadata(trackId: string, patch: MetadataPatch): Promise<Track> {
  return fromStoredTrack(await write<StoredTrack>('library_update_metadata', { trackId, patch }))
}

export async function searchLyrics(title: string, artist?: string, forceRefresh = false, source?: { uploaderName?: string }): Promise<LyricSearchResult> {
  if (!inDesktopShell) return { candidates: [] }
  const epoch = accountEpoch()
  const result = await lookupSongs({ title, artist, source }, async query => {
    const found = await invoke<LyricSearchResult>('lyrics_search', { ...query, forceRefresh })
    return { items: found.candidates, warning: found.warning }
  }, item => `${item.provider}:${item.id}`, () => epoch === accountEpoch())
  return { warning: result.warning, candidates: rankLyricCandidates(result.items, title, artist, 0, result.queries) }
}

const lyricSupplements = new Map<string, Promise<LyricCandidate | null>>()
export async function enrichStoredLyricLines(stored: StoredLyrics): Promise<LyricLine[] | null> {
  if (!inDesktopShell || !['netease', 'qq'].includes(stored.provider)) return null
  const epoch = accountEpoch(), key = `${epoch}:${stored.provider}:${stored.providerLyricId}`
  let request = lyricSupplements.get(key)
  if (!request) {
    request = invoke<LyricCandidate | null>('lyrics_restore_selected', { lyricProvider: stored.provider, id: Number(stored.providerLyricId) })
    lyricSupplements.set(key, request)
    if (lyricSupplements.size > 50) lyricSupplements.delete(lyricSupplements.keys().next().value!)
    void request.catch(() => { if (lyricSupplements.get(key) === request) lyricSupplements.delete(key) })
  }
  const candidate = await request
  if (epoch !== accountEpoch() || !candidate) return null
  const parsed = JSON.parse(stored.parsedJson)
  if (!Array.isArray(parsed) || !parsed.every(line => Number.isFinite(line?.timeMs) && typeof line?.text === 'string')) return null
  // Enrich the saved timeline, preserving its original text and the user's bias.
  const timed = candidateLines(candidate)
  const enriched = parsed.map(line => {
    const match = timed.find(item => item.words?.length && item.text === line.text && Math.abs(item.timeMs-line.timeMs) <= 120)
    return match ? { ...line, words:match.words, endTimeMs:match.endTimeMs ?? line.endTimeMs } : line
  })
  return attachSupplementalLyrics(enriched, candidate.translatedLyrics, candidate.romanizedLyrics)
}

export async function getStoredLyrics(trackId: string): Promise<StoredLyrics | null> {
  if (!inDesktopShell) return null
  const epoch = accountEpoch()
  const stored = await invoke<StoredLyrics | null>('lyrics_get', { trackId })
  // Early builds stored Bilibili captions in the lyric slot. Treat that slot as
  // empty so captions cannot appear when the subtitle switch is off.
  if (epoch !== accountEpoch()) return null
  if (stored?.provider === 'bilibili') return null
  if (stored && !stored.rawText && stored.provider !== 'local') {
    try {
      const candidate = await invoke<LyricCandidate | null>('lyrics_restore_selected', { lyricProvider: stored.provider, id: Number(stored.providerLyricId) })
      if (epoch !== accountEpoch()) return null
      if (candidate && stored.writeToken && stored.accountSession) {
        const completed = await invoke<StoredLyrics | null>('lyrics_complete_selected', { trackId, expected: stored, rawText: candidate.syncedLyrics || candidate.plainLyrics || '', parsedJson: JSON.stringify(candidateLines(candidate)) })
        return epoch === accountEpoch() ? completed : null
      }
    } catch { /* Re-read the selection below: it may have changed during the failed request. */ }
    if (epoch !== accountEpoch()) return null
    const current = await invoke<StoredLyrics | null>('lyrics_get', { trackId })
    return epoch === accountEpoch() ? current : null
  }
  return epoch === accountEpoch() ? stored : null
}

export async function saveStoredLyrics(trackId: string, candidate: LyricCandidate, lines: LyricLine[], manual: boolean): Promise<StoredLyrics> {
  return write<StoredLyrics>('lyrics_save', {
    trackId,
    lyrics: {
      provider: candidate.provider,
      providerLyricId: String(candidate.id),
      rawText: candidate.syncedLyrics || candidate.plainLyrics || '',
      parsedJson: JSON.stringify(lines),
    },
    manual,
  })
}

export const lyricMatchVersion = (trackId: string) => scopedInvoke<string>('lyric_match_version', { trackId })

export async function saveLyricsWithMetadata(trackId: string, candidate: LyricCandidate, lines: LyricLine[], metadata: MetadataPatch, expectedVersion: string) {
  const [stored, track] = await scopedInvoke<[StoredLyrics, StoredTrack]>('lyrics_save_with_metadata', {
    trackId, metadata, expectedVersion, lyrics: {
      provider: candidate.provider, providerLyricId: String(candidate.id), rawText: candidate.syncedLyrics || candidate.plainLyrics || '',
      parsedJson: JSON.stringify(lines),
    },
  })
  window.dispatchEvent(new CustomEvent('bilimusic-lyrics-updated', { detail: stored }))
  window.dispatchEvent(new Event('bilimusic-data-changed'))
  return { stored, track: fromStoredTrack(track) }
}

export async function setStoredLyricsBias(trackId: string, biasMs: number, expected: StoredLyrics): Promise<StoredLyrics> {
  type Result = { status: 'saved'; lyrics: StoredLyrics } | { status: 'conflict'; lyrics: StoredLyrics | null }
  const result = await scopedInvoke<Result>('lyrics_set_bias', { trackId, biasMs, expected })
  if (result.status === 'conflict') {
    throw new LyricBiasConflict(result.lyrics?.provider === 'bilibili' ? null : result.lyrics)
  }
  window.dispatchEvent(new Event('bilimusic-data-changed'))
  return result.lyrics
}

export async function listPlaylists(): Promise<Playlist[]> {
  if (!inDesktopShell) return [{ ...FAVORITES_PLAYLIST }]
  return invoke<Playlist[]>('playlists_list')
}
export const createPlaylist = (name: string) => write<Playlist>('playlist_create', { name })
export const createLinkedPlaylist = (name: string) => write<Playlist>('bili_linked_create', { name })
export async function listPlaylistTracks(playlistId: string): Promise<Track[]> {
  if (!inDesktopShell) return []
  const epoch = accountEpoch()
  const records = await invoke<StoredTrack[]>('playlist_tracks', { playlistId })
  const snapshot = playlistId.startsWith('import:')
    ? await invoke<ImportedEntriesSnapshot>('playlist_import_entries', { playlistId }) : undefined
  if (epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED')
  const entries = new Map(snapshot?.entries.filter(entry => entry.trackId).map(entry => [entry.trackId!, entry]))
  return records.map(record => withTrackTitle({ ...fromStoredTrack(record), importedEntry: entries.get(record.id) }))
}
export const addTracksToPlaylist = (playlistId: string, trackIds: string[], append = false) => write<void>('playlist_add_tracks', { playlistId, trackIds, append })
export const addTrackToPlaylist = (playlistId: string, trackId: string) => write<void>('playlist_add_track', { playlistId, trackId })
export const removeTrackFromPlaylist = (playlistId: string, trackId: string) => write<void>('playlist_remove_track', { playlistId, trackId })
export const removeTracksFromPlaylist = (playlistId: string, trackIds: string[]) => write<void>('playlist_remove_tracks', { playlistId, trackIds })
export const deletePlaylist = (playlistId: string) => write<void>('playlist_delete', { playlistId })
export const renamePlaylist = (playlistId: string, name: string) => write<void>('playlist_rename', { playlistId, name })
export async function searchMetadataCatalog(title: string, artist: string, source: CatalogSource = 'auto', context?: { uploaderName?: string }): Promise<CatalogCandidate[]> {
  if (!inDesktopShell) return []
  const epoch = accountEpoch()
  const result = await lookupSongs({ title, artist, source: context }, async query => ({
    items: await invoke<CatalogCandidate[]>('metadata_catalog_search', { ...query, source }),
  }), item => `${item.source}:${item.trackId}`, () => epoch === accountEpoch())
  return rankCatalogCandidates(result.items, title, artist, result.queries)
}
export async function listDownloads(): Promise<DownloadRecord[]> {
  if (!inDesktopShell) return []
  const records = await invoke<(Omit<DownloadRecord, 'track'> & { track?: StoredTrack })[]>('downloads_list')
  return records.map(record => ({ ...record, track: record.track ? fromStoredTrack(record.track) : undefined }))
}
export async function listOfflinePlayableTracks(): Promise<Track[]> {
  if (!inDesktopShell) return []
  const epoch = accountEpoch()
  const tracks = await invoke<StoredTrack[]>('offline_playable_tracks')
  return epoch === accountEpoch() ? tracks.map(fromStoredTrack) : []
}
export const removeDownload = (downloadId: string) => invoke<void>('download_remove', { downloadId }).then(() => { window.dispatchEvent(new Event('bilimusic-offline-files-changed')) })
export const downloadTrack = (track: Track, targetDirectory: string, skipExisting = false, audioId = 0, exportFormat: 'auto' | 'original' | 'flac' = 'auto') => invoke<boolean>('download_track', {
  trackId: track.id, bvid: track.source.bvid, cid: track.source.cid, title: track.title, targetDirectory, skipExisting, audioId, exportFormat,
})
export async function getAccountProfile(): Promise<AccountProfile> {
  if (!inDesktopShell) return { loggedIn: false }
  return invoke<AccountProfile>('bili_account_profile')
}
export const generateLoginQr = () => invoke<QrLogin>('bili_qr_login_generate')
export const pollLoginQr = (key: string) => invoke<QrLoginStatus>('bili_qr_login_poll', { key })
export const logoutBilibili = () => invoke<void>('bili_logout')
export const getFavoriteFolders = () => invoke<FavoriteFolder[]>('bili_favorite_folders')
export const getFavoriteVideos = (folderId: number, page: number) => invoke<FavoritePage>('bili_favorite_videos', { folderId, page })
export const getLinkedFolder = (folderId: number) => scopedInvoke<LinkedFolder | null>('bili_linked_folder', { folderId })
export function refreshLinkedFolder(folderId: number, link = false, background = false, progress?: (read: number) => void) {
  const onProgress = new Channel<number>()
  if (progress) onProgress.onmessage = progress
  return write<LinkedFolder>('bili_linked_refresh', { folderId, link, background, onProgress })
}
export const changeLinkedVideo = (folderId: number, bvid: string, add: boolean) => write<LinkedFolder>('bili_linked_change', { folderId, bvid, add })
export const removeLinkedVideos = (folderId: number, bvids: string[]) => write<{ folder: LinkedFolder; removed: string[]; failed: { bvid: string; message: string }[] }>('bili_linked_remove_selected', { folderId, bvids })
export const unlinkBiliFolder = (folderId: number) => write<void>('bili_linked_unlink', { folderId })
export const getComments = (aid: number, next = 1) => invoke<CommentPage>('bili_comments', { aid, next })
export const getCommentReplies = (aid: number, root: number, page = 1) => invoke<BiliComment[]>('bili_comment_replies', { aid, root, page })
export const setCommentLike = (aid: number, replyId: number, liked: boolean) => invoke<void>('bili_comment_like', { aid, replyId, liked })
export const replyComment = (aid: number, message: string, root?: number, parent?: number) => invoke<void>('bili_comment_reply', { aid, message, root, parent })

export function toTrackInput(track: Track) {
  track = sourceTrack(track)
  return {
    id: track.id, bvid: track.source.bvid, aid: track.source.aid, cid: track.source.cid, page: track.source.page,
    sourceTitleContext: track.sourceTitleContext, sourceTitle: track.videoTitle || track.displayTitle || track.title, title: track.displayTitle || track.title, artist: track.artist, album: track.album, coverUrl: track.coverUrl,
    durationSeconds: track.durationSeconds, uploaderId: track.source.uploaderId, uploaderName: track.source.uploaderName,
  }
}

export function fromStoredTrack(track: StoredTrack): Track {
  return withTrackTitle({ id: track.id, source: { provider: 'bilibili', bvid: track.bvid, aid: track.aid, cid: track.cid, page: track.page, uploaderId: track.uploaderId, uploaderName: track.uploaderName }, displayTitle: track.titleOverridden ? track.title : track.sourceDisplayTitle, sourceTitleContext: track.sourceTitleContext, titleOverridden: track.titleOverridden, videoTitle: track.sourceVideoTitle, partCount: track.sourceTitleContext?.partCount, title: track.title, artist: track.artist, album: track.album, coverUrl: track.coverUrl?.replace(/^http:\/\//, 'https://'), durationSeconds: track.durationSeconds, liked: track.liked })
}

export { commandErrorMessage } from './userErrors'
