import { create } from 'zustand'
import { recommendationPendingSongs, type RecommendationSong } from '../domain/recommendation'
import type { ImportSong } from '../domain/importedEntry'
import { accountEpoch } from './accountScope'
import { biliRequestPause, type BiliPause } from './biliRequestStatus'
import { findImportCandidates, usePlaylistImport } from './playlistImport'
import { chooseImportMatch } from './playlistImportModel'
import { commandErrorMessage, isConnectionError } from './userErrors'
import { bindRecommendationSong, failRecommendationMatch } from './recommendations'

export type RecommendationMatchStatus = {
  running: boolean
  day?: string
  remaining?: number
  message?: string
  pause?: BiliPause
  retryAt?: number
  error?: string
}
type Run = { epoch: number; day: string; controller: AbortController; stopped: boolean }
type Outcome = 'done' | 'paused' | 'waiting' | 'stopped'

export const useRecommendationMatch = create<Record<string, RecommendationMatchStatus | undefined>>(() => ({}))
const runs = new Map<string, Run>()
const update = (sourceId: string, status: RecommendationMatchStatus) =>
  useRecommendationMatch.setState(current => ({ [sourceId]: status }))

if (typeof window !== 'undefined') window.addEventListener('bilimusic-account-changing', () => {
  for (const run of runs.values()) {
    run.stopped = true
    run.controller.abort()
  }
  runs.clear()
  useRecommendationMatch.setState({}, true)
})

export function stopRecommendationMatching(sourceId: string) {
  const run = runs.get(sourceId)
  if (!run) return
  run.stopped = true
  run.controller.abort()
}

const importing = () => {
  const state = usePlaylistImport.getState().job?.state
  return state === 'matching' || state === 'waiting' || state === 'saving'
}

const importSong = (song: RecommendationSong): ImportSong => ({
  sourceId: `netease:${song.neteaseSongId}`,
  title: song.title,
  artists: song.artists,
  durationSeconds: song.durationSeconds,
  album: song.album,
  coverUrl: song.coverUrl,
})

const errorCode = (error: unknown, fallback: string) =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : fallback

/**
 * Matches one source's pending songs sequentially. The lane is deliberately
 * conservative: Bilibili search and detail lookups share the import request
 * gate, it yields while the user is importing, and every write carries the
 * snapshot's entry revision plus the source's credential token.
 */
export async function runRecommendationMatching(options: {
  sourceId: string
  day: string
  token: string
  songs: RecommendationSong[]
  onSong: (song: RecommendationSong) => void
  onStale: () => void
}): Promise<Outcome> {
  const { sourceId, day, token, songs, onSong, onStale } = options
  const now = Date.now()
  const pending = recommendationPendingSongs(songs, now)
  if (!pending.length) return 'done'
  const existing = runs.get(sourceId)
  if (existing) {
    if (existing.day === day && !existing.stopped) return 'waiting'
    stopRecommendationMatching(sourceId)
  }
  if (importing()) {
    update(sourceId, { running: false, day, message: '等导入完成后再匹配', retryAt: Date.now() + 4000 })
    return 'waiting'
  }

  const run: Run = { epoch: accountEpoch(), day, controller: new AbortController(), stopped: false }
  runs.set(sourceId, run)
  let remaining = pending.length
  update(sourceId, { running: true, day, remaining, message: '正在从 B 站匹配歌曲' })
  const current = () => run.epoch === accountEpoch() && runs.get(sourceId) === run
  const finish = (status: RecommendationMatchStatus) => {
    if (runs.get(sourceId) !== run) return
    runs.delete(sourceId)
    update(sourceId, status)
  }

  for (const song of pending) {
    if (!current() || run.controller.signal.aborted) {
      return 'stopped'
    }
    if (importing()) {
      // A user-started import owns the Bilibili request budget; resume after it.
      update(sourceId, { running: false, day, remaining, message: '等导入完成后再匹配', retryAt: Date.now() + 4000 })
      runs.delete(sourceId)
      return 'waiting'
    }
    remaining--
    try {
      const choices = await findImportCandidates(importSong(song), run.controller.signal)
      if (!current()) return 'stopped'
      const choice = chooseImportMatch(importSong(song), choices)
      if (choice) {
        try {
          const bound = await bindRecommendationSong(sourceId, day, song.neteaseSongId, choice.track, song.entryRevision, token, 'automatic')
          if (!current()) return 'stopped'
          onSong(bound)
        } catch (error) {
          if (!current()) return 'stopped'
          // A refresh or a manual choice moved the row while the search ran.
          if (errorCode(error, '') === 'recommendation_binding_stale' || errorCode(error, '') === 'recommendation_binding_conflict') {
            onStale()
            continue
          }
          throw error
        }
      } else {
        const failed = await failRecommendationMatch(sourceId, day, song.neteaseSongId, 'missing', 'no_candidate', undefined, song.entryRevision, token)
        if (!current()) return 'stopped'
        onSong(failed)
      }
    } catch (error) {
      if (run.controller.signal.aborted || !current()) return 'stopped'
      const pause = biliRequestPause(error)
      if (pause) {
        // Leave this song pending for the retry: a rate limit is not a verdict.
        update(sourceId, { running: false, day, remaining, pause, retryAt: pause.retryAt })
        runs.delete(sourceId)
        return 'paused'
      }
      if (isConnectionError(error)) {
        update(sourceId, { running: false, day, remaining, error: commandErrorMessage(error), retryAt: Date.now() + 15_000 })
        runs.delete(sourceId)
        return 'paused'
      }
      const code = errorCode(error, 'provider_error')
      try {
        const failed = await failRecommendationMatch(sourceId, day, song.neteaseSongId, 'failed', code, undefined, song.entryRevision, token)
        if (!current()) return 'stopped'
        onSong(failed)
      } catch {
        // The row disappeared or its source was removed; the snapshot reload
        // below is authoritative, so do not report a second failure.
        onStale()
        finish({ running: false, day, error: commandErrorMessage(error) })
        return 'stopped'
      }
    }
    if (current()) update(sourceId, { running: true, day, remaining, message: '正在从 B 站匹配歌曲' })
  }
  finish({ running: false, day, remaining: 0 })
  return 'done'
}
