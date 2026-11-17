import type { Track } from './track'
import type { LyricCandidate } from './lyrics'
import { bestCandidate, candidateLines } from './lrc'
import { songQueries, songTextIdentity, songTitleIdentity, type SongQuery } from './songIdentity'

export function chooseAutomaticLyrics(track: Track, candidates: LyricCandidate[], query?: SongQuery) {
  const queries = query ? [query] : songQueries(track)
  return bestCandidate(candidates.filter(candidate => {
    if (candidate.instrumental || !queries.some(query => songTitleIdentity(candidate.trackName) === songTitleIdentity(query.title) && (!query.artist || songTextIdentity(candidate.artistName) === songTextIdentity(query.artist)))) return false
    return (!track.durationSeconds || !candidate.duration || Math.abs(track.durationSeconds - candidate.duration) <= Math.max(15, track.durationSeconds * .08)) && candidateLines(candidate).length > 0
  }), track.durationSeconds)
}

