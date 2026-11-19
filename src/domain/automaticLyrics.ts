import type { Track } from './track'
import type { LyricCandidate } from './lyrics'
import { bestCandidate, candidateLines } from './lrc'
import { primarySongTitle, recognizeSong, songQueries, songTextIdentity, songTitleIdentity, type SongQuery } from './songIdentity'

export function chooseAutomaticLyrics(track: Track, candidates: LyricCandidate[], query?: SongQuery) {
  const queries = query ? [query] : songQueries(track)
  const usable = candidates.filter(candidate => {
    if (candidate.instrumental) return false
    return (!track.durationSeconds || !candidate.duration || Math.abs(track.durationSeconds - candidate.duration) <= Math.max(15, track.durationSeconds * .08)) && candidateLines(candidate).length > 0
  })
  const exact = bestCandidate(usable.filter(candidate => queries.some(q =>
    songTitleIdentity(candidate.trackName) === songTitleIdentity(q.title)
    && (!q.artist || songTextIdentity(candidate.artistName) === songTextIdentity(q.artist)))), track.durationSeconds)
  if (exact) return exact
  // Extend only with an explicit performer and close duration. Shared
  // recognition removes a known performer suffix without dropping editions.
  return bestCandidate(usable.filter(candidate =>
    track.durationSeconds > 0 && candidate.duration > 0
    && Math.abs(track.durationSeconds - candidate.duration) <= Math.max(8, track.durationSeconds * .04)
    && queries.some(q => {
      if (!q.artist || songTextIdentity(q.artist) !== songTextIdentity(candidate.artistName)) return false
      const identity = (title: string) => recognizeSong({ title, artist: q.artist })
      const wanted = identity(q.title), actual = identity(candidate.trackName)
      return [...wanted.editions].sort().join() === [...actual.editions].sort().join()
        && wanted.titles.some(t => actual.titles.some(a => songTextIdentity(primarySongTitle(t)) === songTextIdentity(primarySongTitle(a))))
    })), track.durationSeconds)
}

