import type { QueryClient } from '@tanstack/react-query'
import type { Track } from '../../domain/track'
import type { LyricCandidate } from '../../domain/lyrics'
import { candidateLines } from '../../domain/lrc'
import { accountEpoch } from '../../services/accountScope'
import { metadataForLyric } from '../../services/batchMatching'
import { lyricMatchVersion, saveLyricsWithMetadata, saveStoredLyrics } from '../../services/desktopApi'
import { usePlayerStore } from '../player/playerStore'

export async function saveTrackLyrics(track: Track, candidate: LyricCandidate, updateMetadata: boolean, client: QueryClient, valid: () => boolean) {
  const lines = candidateLines(candidate)
  if (!lines.length) throw new Error('这个版本没有可显示的歌词')
  if (!updateMetadata) return saveStoredLyrics(track.id, candidate, lines, true)
  const epoch = accountEpoch()
  const version = await lyricMatchVersion(track.id)
  const metadata = await metadataForLyric(candidate)
  if (epoch !== accountEpoch() || !valid()) return
  const pair = await saveLyricsWithMetadata(track.id, candidate, lines, metadata, version)
  if (epoch !== accountEpoch()) return
  usePlayerStore.getState().updateTrack(pair.track)
  for (const key of ['library', 'playlists', 'playlist-tracks', 'home-recent']) void client.invalidateQueries({queryKey: [key]})
  return pair.stored
}
