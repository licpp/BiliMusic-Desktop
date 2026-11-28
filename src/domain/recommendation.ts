import type { Track } from './track'

/** The recommendation day changes at 06:00 Asia/Shanghai, observed upstream. */
export const RECOMMENDATION_REFRESH_HOUR = 6
const RECOMMENDATION_UTC_OFFSET_MINUTES = 8 * 60
export const RECOMMENDATION_SOURCE_NAME_MAX = 40

export type RecommendationProvider = 'netease'
export type RecommendationRefreshState = 'idle' | 'refreshing' | 'ready' | 'error' | 'auth-required'
export type RecommendationMatchState = 'pending' | 'matched' | 'missing' | 'failed'
export type RecommendationMatchMode = 'automatic' | 'manual'

export type RecommendationSource = {
  id: string
  provider: RecommendationProvider
  providerUid: string
  nickname: string
  name: string
  nameCustom: boolean
  sortOrder: number
  revision: number
  credentialToken: string
  termsAcceptedAt?: number
  lastRefreshAt?: number
  lastRefreshState: RecommendationRefreshState
  lastErrorCode?: string
  lastErrorAt?: number
  retryAt?: number
  createdAt: number
  updatedAt: number
}

export type RecommendationSong = {
  sourceId: string
  day: string
  position: number
  neteaseSongId: string
  title: string
  artists: string[]
  album?: string
  durationSeconds?: number
  coverUrl?: string
  matchState: RecommendationMatchState
  track?: Track
  bvid?: string
  cid?: number
  matchMode?: RecommendationMatchMode
  entryRevision: number
  matchAttempts: number
  matchRetryAt?: number
  matchErrorCode?: string
  matchedAt?: number
}

export type RecommendationSnapshot = {
  source: RecommendationSource
  day: string
  fetchedAt?: number
  songCount: number
  songs: RecommendationSong[]
}

export type RecommendationBindingRef = Pick<RecommendationSong, 'sourceId' | 'day' | 'neteaseSongId' | 'entryRevision'>

const pad = (value: number) => String(value).padStart(2, '0')

/** Returns the UTC calendar date whose 06:00 Asia/Shanghai window contains `now`. */
export function recommendationDay(now: Date): string {
  const local = new Date(now.getTime() + RECOMMENDATION_UTC_OFFSET_MINUTES * 60_000)
  if (local.getUTCHours() < RECOMMENDATION_REFRESH_HOUR) local.setUTCDate(local.getUTCDate() - 1)
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
}

/** The banner uses `DD / MM`, matching the reference layout. */
export function recommendationDayLabel(day: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  return match
    ? { day: match[3], month: match[2], display: `${match[3]} / ${match[2]}` }
    : { day: '--', month: '--', display: '-- / --' }
}

export function defaultRecommendationSourceName(nickname: string, index = 1) {
  const clean = nickname.trim()
  return clean ? `网易云音乐 · ${clean}` : `推荐源 ${index}`
}

/** A renamed source keeps its name; the default name follows the current nickname. */
export function recommendationSourceName(source: Pick<RecommendationSource, 'name' | 'nameCustom' | 'nickname'>, index = 1) {
  return source.nameCustom && source.name.trim() ? source.name.trim() : defaultRecommendationSourceName(source.nickname, index)
}

/**
 * The account line under a source. The default name ("网易云音乐 · <nickname>")
 * already shows the nickname, and a renamed source usually keeps it if it names
 * the account, so the line is dropped whenever the name already contains the
 * nickname; a source whose name never mentions it keeps the line, because only
 * the line tells which account it is.
 */
export function recommendationSourceAccount(source: Pick<RecommendationSource, 'name' | 'nickname'>): string | undefined {
  const nickname = source.nickname.trim()
  return nickname && source.name.includes(nickname) ? undefined : nickname || '未命名账号'
}

export function validateRecommendationSourceName(name: string): string | undefined {
  const clean = name.trim()
  if (!clean) return '推荐源名称不能为空'
  if ([...clean].length > RECOMMENDATION_SOURCE_NAME_MAX) return `推荐源名称不能超过 ${RECOMMENDATION_SOURCE_NAME_MAX} 个字符`
  if (/[\u0000-\u001f\u007f]/.test(clean)) return '推荐源名称不能包含控制字符'
  return undefined
}

/** Automatic matching may never overwrite a manual choice or an older row revision. */
export function canApplyAutomaticMatch(song: Pick<RecommendationSong, 'matchMode' | 'entryRevision'>, expectedEntryRevision: number) {
  return song.matchMode !== 'manual' && song.entryRevision === expectedEntryRevision
}

export function bindRecommendationSong(
  song: RecommendationSong,
  track: Track,
  mode: RecommendationMatchMode,
  expectedEntryRevision: number,
  matchedAt: number,
): RecommendationSong | undefined {
  if (song.entryRevision !== expectedEntryRevision) return undefined
  if (mode === 'automatic' && song.matchMode === 'manual') return undefined
  return {
    ...song,
    matchState: 'matched',
    track,
    bvid: track.source.bvid,
    cid: track.source.cid,
    matchMode: mode,
    entryRevision: song.entryRevision + 1,
    matchAttempts: song.matchAttempts + 1,
    matchErrorCode: undefined,
    matchRetryAt: undefined,
    matchedAt,
  }
}

/** Play-all uses the matched subset, preserves upstream order and never repeats a track. */
export function playableRecommendationTracks(songs: RecommendationSong[]): Track[] {
  const seen = new Set<string>()
  return [...songs]
    .sort((left, right) => left.position - right.position)
    .flatMap(song => {
      const track = song.matchState === 'matched' ? song.track : undefined
      if (!track || seen.has(track.id)) return []
      seen.add(track.id)
      return [{ ...track, recommendationBinding: {
        sourceId: song.sourceId, day: song.day, neteaseSongId: song.neteaseSongId, entryRevision: song.entryRevision,
      } }]
    })
}

export function recommendationPlaybackNotice(total: number, matched: number): string | undefined {
  if (total <= 0) return '今天还没有推荐歌曲'
  if (matched <= 0) return `共 ${total} 首，暂无可播放的 B 站匹配`
  if (matched < total) return `共 ${total} 首，已匹配 ${matched} 首；未匹配的 ${total - matched} 首不会播放`
  return undefined
}

/** Default name offered when today's matched songs are saved as a playlist. */
export function recommendationPlaylistName(day: string): string {
  const [, month, date] = day.split('-')
  const m = Number(month)
  const d = Number(date)
  return Number.isInteger(m) && Number.isInteger(d) && m > 0 && d > 0 ? `每日推荐 ${m}月${d}日` : '每日推荐'
}

/**
 * A Bilibili folder holds whole videos, so a matched part of a multi-P video
 * cannot be represented there: adding the video would play a different part.
 * Those matches, and a video already queued by another entry, are skipped.
 */
export function folderPlayableTracks(tracks: Track[]): { included: Track[]; skipped: number } {
  const seen = new Set<string>()
  const included = tracks.filter(track => {
    if ((track.partCount ?? 1) !== 1 || seen.has(track.source.bvid)) return false
    seen.add(track.source.bvid)
    return true
  })
  return { included, skipped: tracks.length - included.length }
}

export type RecommendationMatchSummary = {
  total: number
  matched: number
  pending: number
  missing: number
  failed: number
}

export function recommendationMatchSummary(songs: RecommendationSong[]): RecommendationMatchSummary {
  const summary: RecommendationMatchSummary = { total: songs.length, matched: 0, pending: 0, missing: 0, failed: 0 }
  for (const song of songs) {
    if (song.matchState === 'matched') summary.matched++
    else if (song.matchState === 'missing') summary.missing++
    else if (song.matchState === 'failed') summary.failed++
    else summary.pending++
  }
  return summary
}

/** Songs the lane may still try: pending rows whose own retry time has passed. */
export function recommendationPendingSongs(songs: RecommendationSong[], now: number) {
  return songs.filter(song => song.matchState === 'pending' && (song.matchRetryAt === undefined || song.matchRetryAt <= now))
}

/** Merges one row returned by a guarded write without trusting a stale list. */
export function replaceRecommendationSong(snapshot: RecommendationSnapshot, song: RecommendationSong): RecommendationSnapshot {
  const songs = snapshot.songs.map(item =>
    item.neteaseSongId === song.neteaseSongId && item.sourceId === song.sourceId && item.day === song.day ? song : item)
  return { ...snapshot, songs }
}

/** Retry delay after Bilibili asks the client to back off; undefined when it gave no time. */
export function recommendationRetryDelay(retryAt: number | undefined, now: number) {
  if (retryAt === undefined || !Number.isFinite(retryAt)) return undefined
  return Math.max(0, retryAt - now)
}

/**
 * QR polling only repeats errors that can heal. A non-retryable error (an
 * unknown attempt or an account-safety verification gate) can never succeed by
 * polling again, so the dialog stops instead of hammering the endpoint.
 */
export function qrPollingCanRetry(error: unknown): boolean {
  return !(typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === false)
}

export function qrLoginFailureState(error: unknown, polling: boolean): 'verify' | 'retrying' | 'error' {
  if (commandErrorCode(error) === 'netease_verification_required') return 'verify'
  return polling && qrPollingCanRetry(error) ? 'retrying' : 'error'
}

/**
 * Closing the embedded login window (or the in-app cancel button) is a normal
 * outcome, not a failure: the view returns to the login intro instead of
 * showing an error with a retry CTA.
 */
export function isNeteaseLoginCancelled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'netease_login_cancelled'
}

/**
 * Command errors carry a stable `code`. The QR dialog reads it to offer the
 * official-page login only for the safety gate, not for a generic failure.
 */
export function commandErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
