import { invoke } from '@tauri-apps/api/core'
import type { Track } from '../domain/track'
import type { CatalogCandidate, MetadataPatch } from '../domain/library'
import type { LyricCandidate } from '../domain/lyrics'
import { candidateLines } from '../domain/lrc'
import { songTitleIdentity, songTextIdentity } from '../domain/songIdentity'
import { accountEpoch } from './accountScope'
import { getStoredLyrics, searchLyrics, searchMetadataCatalog, toTrackInput } from './desktopApi'
import { chooseAutomaticLyrics } from '../domain/automaticLyrics'

export type BatchMatchProgress = { done:number; total:number; matched:number; skipped:number; failed:number; protected:number; unmatched:number; conflicts:number }
/** Metadata is derived from the selected lyric's identity. Catalog results may
 * enrich that identity, but never replace it with an independently ranked song. */
export function matchingMetadata(lyric:LyricCandidate, catalog:CatalogCandidate[] = []):MetadataPatch {
  const same=catalog.filter(c=>songTitleIdentity(c.trackName)===songTitleIdentity(lyric.trackName)
    && songTextIdentity(c.artistName)===songTextIdentity(lyric.artistName)
    && (!lyric.albumName || songTextIdentity(c.collectionName || '')===songTextIdentity(lyric.albumName)))
  const best=catalog.find(c=>c.trackId===`${lyric.provider}:${lyric.id}`)
    || (lyric.provider==='lrclib' && new Set(same.map(c=>songTextIdentity(c.collectionName || ''))).size===1 ? same[0] : undefined)
  return {title:lyric.trackName,artist:lyric.artistName.trim()||undefined,album:lyric.albumName.trim()||best?.collectionName||undefined,coverUrl:lyric.artworkUrl||best?.artworkUrl}
}
export async function metadataForLyric(lyric: LyricCandidate): Promise<MetadataPatch> {
  if (lyric.artworkUrl || !lyric.artistName.trim()) return matchingMetadata(lyric)
  const source = lyric.provider === 'qq' || lyric.provider === 'netease' ? lyric.provider : 'auto'
  const catalog = await searchMetadataCatalog(lyric.trackName, lyric.artistName, source).catch(() => [])
  return matchingMetadata(lyric, catalog)
}

type MatchJob = { folderId: number; runId: string; bvid: string; session: string }
type MatchResult = { outcome: 'matched'; track: Track } | { outcome: 'protected' | 'unmatched' | 'conflict' | 'failed' }

export async function matchBatchTrack(track: Track, check: () => void, allowNewTracks: boolean, job?: MatchJob): Promise<MatchResult> {
  check()
  const before = await invoke<{ session: string; lyricToken: string | null; protected: boolean; trackExists?: boolean }>(
    'batch_match_snapshot', { trackId: track.id, ...(allowNewTracks && { allowMissing: true }) },
  )
  check()
  if (job && job.session !== before.session) throw new DOMException('账号已切换', 'AbortError')
  if (before.protected) return { outcome: 'protected' }
  const result = await searchLyrics(track.title, track.artist, false, track.source)
  check()
  const lyric = chooseAutomaticLyrics(track, result.candidates)
  if (!lyric) return { outcome: result.warning ? 'failed' : 'unmatched' }
  const metadata = await metadataForLyric(lyric)
  check()
  const saved = await invoke<boolean>('batch_match_commit', {
    trackId: track.id, expectedSession: before.session, expectedLyricToken: before.lyricToken, metadata,
    lyrics: { provider: lyric.provider, providerLyricId: String(lyric.id), rawText: lyric.syncedLyrics || lyric.plainLyrics || '', parsedJson: JSON.stringify(candidateLines(lyric)) },
    ...(allowNewTracks && before.trackExists === false && { newTrack: toTrackInput(track) }),
    ...(job && { job: { folderId: job.folderId, runId: job.runId, bvid: job.bvid } }),
  })
  check()
  if (!saved) return { outcome: 'conflict' }
  return { outcome: 'matched', track: { ...track, ...metadata, coverUrl: metadata.coverUrl || track.coverUrl, titleOverridden: true, displayTitle: metadata.title } }
}

export async function notifyBatchLyrics(trackId: string, check: () => void) {
  const stored = await getStoredLyrics(trackId).catch(() => null)
  check()
  if (stored) window.dispatchEvent(new CustomEvent('bilimusic-lyrics-updated', { detail: stored }))
}

export async function matchTracksAutomatically(tracks: Track[], signal: AbortSignal, progress: (p: BatchMatchProgress) => void, onSaved?: (track: Track) => void, allowNewTracks = false) {
  const epoch = accountEpoch(), unique = [...new Map(tracks.map(track => [track.id, track])).values()]
  const state: BatchMatchProgress = { done: 0, total: unique.length, matched: 0, skipped: 0, failed: 0, protected: 0, unmatched: 0, conflicts: 0 }
  const check = () => { if (signal.aborted || epoch !== accountEpoch()) throw new DOMException('已停止匹配', 'AbortError') }
  progress({ ...state })
  try {
    for (const track of unique) {
      check()
      try {
        const result = await matchBatchTrack(track, check, allowNewTracks)
        switch (result.outcome) {
          case 'matched':
            state.matched++
            onSaved?.(result.track)
            await notifyBatchLyrics(track.id, check)
            break
          case 'protected': state.protected++; state.skipped++; break
          case 'unmatched': state.unmatched++; state.skipped++; break
          case 'conflict': state.conflicts++; state.skipped++; break
          case 'failed': state.failed++; break
        }
      } catch {
        check()
        state.failed++
      } finally {
        state.done++
        if (!signal.aborted && epoch === accountEpoch()) progress({ ...state })
      }
    }
    check()
    return state
  } finally {
    if (state.matched && epoch === accountEpoch()) window.dispatchEvent(new Event('bilimusic-data-changed'))
  }
}
