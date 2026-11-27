import { invoke, isTauri } from '@tauri-apps/api/core'
import type { Playlist } from '../domain/library'
import { folderPlayableTracks } from '../domain/recommendation'
import type { Track } from '../domain/track'
import { accountEpoch } from './accountScope'
import { addTracksToPlaylist, changeLinkedVideo, createLinkedPlaylist, createPlaylist, prepareRecommendationTracks, saveLibraryTrack } from './desktopApi'
import type {
  RecommendationMatchMode,
  RecommendationMatchState,
  RecommendationSnapshot,
  RecommendationSong,
  RecommendationSource,
} from '../domain/recommendation'

const unavailable = () => new Error('每日推荐需要在桌面应用中登录网易云账号')

/** Local keys are device-scoped: the Bilibili account session never isolates them. */
export const recommendationQueryKey = {
  sources: ['recommendations', 'sources'] as const,
  daily: (sourceId: string, day: string) => ['recommendations', 'daily', sourceId, day] as const,
  none: ['recommendations', 'daily', 'none'] as const,
}
export const RECOMMENDATION_SOURCE_STORAGE = 'recommendation-source'

export type NeteaseQrGenerate = { attemptId: string; qrUrl: string }
export type NeteaseQrStatus = 'waiting' | 'scanned' | 'authorized' | 'expired'
export type NeteaseQrPoll = { status: NeteaseQrStatus; source?: RecommendationSource }
export type RecommendationRefreshResult = { snapshot?: RecommendationSnapshot; needsConfirmation: boolean }

type RawSource = Omit<RecommendationSource, 'lastRefreshState'> & { lastRefreshState: string }
type RawSong = Omit<RecommendationSong, 'matchState' | 'matchMode'> & {
  matchState: string
  matchMode?: string
}
type RawSnapshot = Omit<RecommendationSnapshot, 'source' | 'songs'> & {
  source: RawSource
  songs: RawSong[]
}

const sourceOf = (raw: RawSource): RecommendationSource => ({
  ...raw,
  lastRefreshState: raw.lastRefreshState as RecommendationSource['lastRefreshState'],
})
const songOf = (raw: RawSong): RecommendationSong => ({
  ...raw,
  matchState: raw.matchState as RecommendationMatchState,
  matchMode: raw.matchMode as RecommendationMatchMode | undefined,
})
const snapshotOf = (raw: RawSnapshot): RecommendationSnapshot => ({
  ...raw,
  source: sourceOf(raw.source),
  songs: raw.songs.map(songOf),
})

export async function listRecommendationSources(): Promise<RecommendationSource[]> {
  if (!isTauri()) return []
  return (await invoke<RawSource[]>('recommendation_sources')).map(sourceOf)
}

export async function dailyRecommendation(sourceId: string, day: string): Promise<RecommendationSnapshot | undefined> {
  if (!isTauri()) return undefined
  const raw = await invoke<RawSnapshot | null>('recommendation_daily', { sourceId, day })
  return raw ? snapshotOf(raw) : undefined
}

export async function refreshRecommendation(sourceId: string, day: string, expectedToken: string, confirmEmpty = false): Promise<RecommendationRefreshResult> {
  if (!isTauri()) throw unavailable()
  const raw = await invoke<{ snapshot: RawSnapshot | null; needsConfirmation: boolean }>('recommendation_refresh', {
    sourceId, day, expectedToken, confirmEmpty,
  })
  return { snapshot: raw.snapshot ? snapshotOf(raw.snapshot) : undefined, needsConfirmation: raw.needsConfirmation }
}

export async function generateNeteaseQr(termsAccepted: boolean): Promise<NeteaseQrGenerate> {
  if (!isTauri()) throw unavailable()
  return invoke<NeteaseQrGenerate>('netease_qr_login_generate', { termsAccepted })
}

export async function pollNeteaseQr(attemptId: string, termsAccepted: boolean): Promise<NeteaseQrPoll> {
  if (!isTauri()) throw unavailable()
  const raw = await invoke<{ status: NeteaseQrStatus; source?: RawSource }>('netease_qr_login_poll', { attemptId, termsAccepted })
  return { status: raw.status, source: raw.source ? sourceOf(raw.source) : undefined }
}

export async function cancelNeteaseQr(attemptId: string): Promise<void> {
  if (!isTauri()) return
  await invoke('netease_qr_login_cancel', { attemptId })
}

export async function webLoginNetease(termsAccepted: boolean): Promise<RecommendationSource> {
  if (!isTauri()) throw unavailable()
  return sourceOf(await invoke<RawSource>('netease_web_login', { termsAccepted }))
}

/**
 * What ended the web login that reloaded the app page. The Android login
 * replaces the page, so the command above never resolves into the document
 * that started it; the reloaded page asks for the outcome instead.
 */
export type WebLoginOutcome = {
  /** Wall clock when the login ended, compared against the marker's start. */
  finishedAt: number
  source?: RecommendationSource
  error?: { code?: string; message?: string; retryable?: boolean }
}

export async function webLoginOutcome(): Promise<WebLoginOutcome | undefined> {
  if (!isTauri()) return undefined
  const raw = await invoke<(Omit<WebLoginOutcome, 'source'> & { source?: RawSource }) | null>('netease_web_login_outcome')
  if (!raw) return undefined
  return { finishedAt: raw.finishedAt, source: raw.source ? sourceOf(raw.source) : undefined, error: raw.error }
}

export async function cancelNeteaseWebLogin(): Promise<void> {
  if (!isTauri()) return
  await invoke('netease_web_login_cancel')
}

export async function bindRecommendationSong(
  sourceId: string,
  day: string,
  songId: string,
  track: unknown,
  expectedEntryRevision: number,
  expectedToken: string,
  mode: RecommendationMatchMode,
): Promise<RecommendationSong> {
  if (!isTauri()) throw unavailable()
  const command = mode === 'manual' ? 'recommendation_bind_manual' : 'recommendation_bind'
  return songOf(await invoke<RawSong>(command, { sourceId, day, songId, track, expectedEntryRevision, expectedToken }))
}

export async function failRecommendationMatch(
  sourceId: string,
  day: string,
  songId: string,
  matchState: 'missing' | 'failed',
  errorCode: string | undefined,
  retryAt: number | undefined,
  expectedEntryRevision: number,
  expectedToken: string,
): Promise<RecommendationSong> {
  if (!isTauri()) throw unavailable()
  return songOf(await invoke<RawSong>('recommendation_match_fail', {
    sourceId, day, songId, matchState, errorCode, retryAt, expectedEntryRevision, expectedToken,
  }))
}

export async function resetRecommendationMatches(sourceId: string, day: string, expectedToken: string): Promise<number> {
  if (!isTauri()) throw unavailable()
  return invoke<number>('recommendation_match_reset', { sourceId, day, expectedToken })
}

export async function renameRecommendationSource(sourceId: string, name: string, expectedRevision: number): Promise<RecommendationSource> {
  if (!isTauri()) throw unavailable()
  return sourceOf(await invoke<RawSource>('recommendation_source_rename', { sourceId, name, expectedRevision }))
}

export async function removeRecommendationSource(sourceId: string, expectedRevision: number): Promise<void> {
  if (!isTauri()) throw unavailable()
  await invoke('recommendation_source_remove', { sourceId, expectedRevision })
}

export async function clearRecommendationData(): Promise<number> {
  if (!isTauri()) return 0
  return invoke<number>('recommendation_clear_all')
}

export type RecommendationPlaylistWrite = {
  playlistId: string
  playlistName: string
  /** Set for a Bilibili folder so the caller can refresh its cached snapshot. */
  folderId?: number
  added: number
  skipped: number
}

/**
 * The destination was created, but writing the tracks stopped partway. The
 * playlist is already on the account (and, for a folder, on Bilibili), so the
 * caller must not create a second one on retry; it can append to this one.
 */
export class RecommendationPlaylistPartialError extends Error {
  constructor(readonly playlist: Playlist, readonly added: number, readonly skipped: number, readonly reason: unknown) {
    super('RECOMMENDATION_PLAYLIST_PARTIAL')
    this.name = 'RecommendationPlaylistPartialError'
  }
}

class TrackWriteError extends Error {
  constructor(readonly added: number, readonly skipped: number, readonly reason: unknown) {
    super('RECOMMENDATION_TRACK_WRITE_FAILED')
    this.name = 'TrackWriteError'
  }
}

const unwrapTrackWrite = (cause: unknown) => cause instanceof TrackWriteError ? cause.reason : cause

/**
 * Saves the matches a day already produced; nothing here searches Bilibili.
 * A local playlist keeps every matched part, while a Bilibili folder can only
 * hold whole single-part videos, so multi-P matches are reported as skipped
 * instead of silently recording a different part.
 */
export async function saveRecommendationPlaylist(name: string, tracks: Track[], linked: boolean): Promise<RecommendationPlaylistWrite> {
  if (!isTauri()) throw unavailable()
  const epoch = accountEpoch()
  const guard = () => { if (epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED') }
  const playlist = linked ? await createLinkedPlaylist(name) : await createPlaylist(name)
  guard()
  try {
    const written = linked
      ? await writeFolderTracks(playlist, tracks, guard)
      : await writeLocalTracks(playlist, tracks, guard)
    return { playlistId: playlist.id, playlistName: playlist.name, folderId: playlist.biliFolderId, ...written }
  } catch (cause) {
    // Do not leave the user with an invisible half-written playlist: report
    // what exists so the dialog can offer a retry into the same destination.
    const failure = cause instanceof TrackWriteError ? cause : new TrackWriteError(0, 0, cause)
    throw new RecommendationPlaylistPartialError(playlist, failure.added, failure.skipped, failure.reason)
  }
}

/** Appends today's matches to a playlist the user already owns. */
export async function addRecommendationTracksToPlaylist(playlist: Playlist, tracks: Track[]): Promise<RecommendationPlaylistWrite> {
  if (!isTauri()) throw unavailable()
  const epoch = accountEpoch()
  const guard = () => { if (epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED') }
  let written: { added: number; skipped: number }
  try {
    written = playlist.biliFolderId
      ? await writeFolderTracks(playlist, tracks, guard)
      : await writeLocalTracks(playlist, tracks, guard)
  } catch (cause) {
    throw unwrapTrackWrite(cause)
  }
  return { playlistId: playlist.id, playlistName: playlist.name, folderId: playlist.biliFolderId, ...written }
}

async function writeLocalTracks(playlist: Playlist, tracks: Track[], guard: () => void) {
  const ids: string[] = []
  try {
    const prepared = await prepareRecommendationTracks(tracks)
    guard()
    for (const [index, track] of prepared.entries()) {
      guard()
      ids.push(track === tracks[index] ? (await saveLibraryTrack(track)).id : track.id)
    }
    if (ids.length) {
      guard()
      await addTracksToPlaylist(playlist.id, ids, true)
    }
  } catch (cause) {
    throw new TrackWriteError(ids.length, 0, cause)
  }
  return { added: ids.length, skipped: 0 }
}

async function writeFolderTracks(playlist: Playlist, tracks: Track[], guard: () => void) {
  const folderId = playlist.biliFolderId
  if (!folderId) throw new Error('NOT_A_BILIBILI_FOLDER')
  const { included, skipped } = folderPlayableTracks(tracks)
  let added = 0
  try {
    for (const track of included) {
      guard()
      await changeLinkedVideo(folderId, track.source.bvid, true)
      added += 1
    }
  } catch (cause) {
    throw new TrackWriteError(added, skipped, cause)
  }
  return { added, skipped }
}
