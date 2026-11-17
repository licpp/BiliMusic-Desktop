import type { Track } from './track'

/** Keep a catalog view separate from the Bilibili/user record written to SQLite.
 * Both travel with the queue so native background playback and restoration use
 * the same view, without changing the BVID + CID identity or sync protocol. */
export function sourceTrack(track: Track): Track {
  if (!track.importedSourceMetadata) return track
  const { importedSourceMetadata, ...rest } = track
  // Undefined fields disappear from JSON snapshots; clear them explicitly so
  // catalog artist/album values cannot leak into the restored source record.
  return track.titleOverridden ? rest : { ...rest,
    title: importedSourceMetadata.title, displayTitle: importedSourceMetadata.displayTitle,
    artist: importedSourceMetadata.artist, album: importedSourceMetadata.album, coverUrl: importedSourceMetadata.coverUrl,
  }
}

export function importedPresentation(track: Track): Track {
  const entry = track.importedEntry
  if (track.titleOverridden || !entry || entry.trackId !== track.id) return track
  return {
    ...track,
    importedSourceMetadata: { title: track.title, displayTitle: track.displayTitle, artist: track.artist, album: track.album, coverUrl: track.coverUrl },
    title: entry.song.title, displayTitle: entry.song.title,
    artist: entry.song.artists.join(' / ') || track.artist,
    album: entry.song.album || track.album,
    coverUrl: entry.song.coverUrl || track.coverUrl,
  }
}
