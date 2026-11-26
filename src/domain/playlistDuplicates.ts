import { readableSongText } from './songIdentity'
import type { Track } from './track'

export function duplicateAudioRank(quality?: { lossless: boolean; bitrate: number }) {
  if (quality?.lossless) return Infinity
  if (quality && Number.isFinite(quality.bitrate) && quality.bitrate > 0) return quality.bitrate
}

/** A missing score cannot establish a winner. Ties keep the first playlist entry. */
export function preferredDuplicate(candidates: Track[], score: (track: Track) => number | undefined) {
  let winner: Track | undefined
  let best = -1
  for (const track of candidates) {
    const value = score(track)
    if (value === undefined) return
    if (value > best) { best = value; winner = track }
  }
  return winner
}

export function playlistDuplicateMetadata(track: Track) {
  const song = track.titleOverridden ? undefined : track.importedEntry?.song
  return {
    title: song?.title || track.displayTitle || track.title,
    artist: song ? song.artists.join(' / ') : track.artist || '',
    album: song?.album || track.album || '',
  }
}

export function findPlaylistDuplicates(tracks: Track[]) {
  const buckets = new Map<string, Track[]>()
  for (const track of tracks) {
    const { title, artist, album } = playlistDuplicateMetadata(track)
    const fields = [title, artist, album].map(field => readableSongText(field).trim().replace(/\s+/g, ' '))
    if (fields.some(field => !field)) continue
    const key = JSON.stringify(fields)
    const group = buckets.get(key)
    if (group) group.push(track)
    else buckets.set(key, [track])
  }
  return [...buckets.values()].filter(group => group.length > 1)
}
