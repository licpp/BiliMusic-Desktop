import type { ExternalSong } from './songIdentity'
export type ImportSong = ExternalSong & { sourceId: string; album?: string; coverUrl?: string }
/** A playlist position is stable across source replacements. Track identity is
 * still BVID + CID; no alternate identity enters playback/history/favorites. */
export type ImportedEntry = {
  entryId: string
  playlistId: string
  order: number
  song: ImportSong
  trackId?: string
  mode?: 'automatic' | 'manual'
  revision: string
  message?: string
}
export type ImportedEntriesSnapshot = { session: string; entries: ImportedEntry[] }
