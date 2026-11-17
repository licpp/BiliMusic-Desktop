import type { ImportedEntry, ImportedEntriesSnapshot } from '../domain/importedEntry'
import type { ImportChoice } from './playlistImportModel'
import { withTrackTitle } from '../domain/sourceTitle'
import { playbackIntent, usePlayerStore } from '../features/player/playerStore'

/** A binding changes a playlist slot, never an existing song's identity.
 * Late writes cannot take over a newer playback intent. */
export function refreshImportedPlayback(before: ImportedEntry, choice: ImportChoice, snapshot: ImportedEntriesSnapshot, intent: number) {
  const entry = snapshot.entries.find(e => e.entryId === before.entryId && e.trackId === choice.track.id)
  if (!entry) return
  const next = withTrackTitle({ ...choice.track, importedEntry: entry })
  const state = usePlayerStore.getState()
  const belongs = (track: typeof next) => track.importedEntry?.entryId === entry.entryId && track.importedEntry.playlistId === entry.playlistId
  const replace = (tracks: typeof next[]) => tracks.some(belongs) ? tracks.flatMap(track => belongs(track) ? [next] : track.id === next.id ? [] : [track]) : tracks
  const active = state.current && belongs(state.current) && intent === playbackIntent()
  const restart = active && ['playing','buffering','resolving'].includes(state.status)
  const queueOrigins = { ...state.queueOrigins }
  for (const old of state.queue) if (belongs(old)) queueOrigins[next.id] = queueOrigins[old.id] || ['']
  usePlayerStore.setState({ queue: replace(state.queue), queueBase: replace(state.queueBase || state.queue), queueOrigins,
    ...(active && !restart ? { current: next, progressSeconds: 0, durationSeconds: next.durationSeconds, error: null } : {}) })
  if (restart) void usePlayerStore.getState().play(next, 0)
}
