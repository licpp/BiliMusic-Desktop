import { invoke, isTauri } from '@tauri-apps/api/core'
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
