import { withTrackTitle } from '../domain/sourceTitle'
import { sourceTrack } from '../domain/importedPresentation'
import type { ImportedEntry } from '../domain/importedEntry'
import { toTrack } from './collectionTrack'
import type { Track } from '../domain/track'
import { invoke } from '@tauri-apps/api/core'
import type { QueryClient } from '@tanstack/react-query'
import { usePlayerStore } from '../features/player/playerStore'
import { inDesktopShell, fromStoredTrack, getVideoParts } from './desktopApi'
import type { StoredTrack } from '../domain/library'
import { accountEpoch } from './accountScope'
const attempted = new Map<string, number>()
export async function hydrateSourceTitles(ids: string[], client: QueryClient, cacheOnly = false) {
  if (!inDesktopShell) return
  const epoch = accountEpoch(), now = Date.now()
  const pending: string[] = []
  for (const id of new Set(ids)) {
    const key = `${epoch}:${id}`
    if (!cacheOnly && (attempted.get(key) || 0) > now - 300_000) continue
    if (!cacheOnly) attempted.set(key, now)
    pending.push(id)
    if (pending.length === 50) break
  }
  if (attempted.size > 1000) for (const [key, time] of attempted) if (time < now - 300_000) attempted.delete(key)
  let changed = 0
  for (let i = 0; !cacheOnly && i < pending.length && epoch === accountEpoch(); i += 8) {
    try { changed += await invoke<number>('sync_hydrate_sources', { titleIds: pending.slice(i, i + 8) }) }
    catch { break } // Metadata failure never blocks playback or hides the cached name.
  }
  if (epoch === accountEpoch()) {
    const updates = new Map<Track,Track>()
    const snapshot = usePlayerStore.getState()
    const observed = [...snapshot.queue, ...(snapshot.current ? [snapshot.current] : [])].filter(track=>pending.includes(track.id))
    const expected = new Set(observed)
    const missingContext = [...new Set(observed.filter(track => !track.importedEntry).map(track => track.id))]
    const entries = missingContext.length ? await invoke<ImportedEntry[]>('playlist_import_contexts', { trackIds: missingContext }).catch(() => []) : []
    if (epoch !== accountEpoch()) return
    const contexts = new Map(Array.isArray(entries) ? entries.map(entry => [entry.trackId, entry]) : [])
    const reads = new Map<string, Promise<StoredTrack | null>>()
    for (const track of new Set(observed)) {
      let stored: StoredTrack | null
      try {
        let read = reads.get(track.id)
        if (!read) { read = invoke<StoredTrack | null>('sync_current_track', {trackId:track.id}); reads.set(track.id, read) }
        stored = await read
      }
      catch { if (epoch !== accountEpoch()) return; continue }
      if (epoch !== accountEpoch()) return
      if (stored) {const next=withTrackTitle({...sourceTrack(track),...fromStoredTrack(stored),importedEntry:track.importedEntry || contexts.get(track.id),sourceTitleContext:stored.sourceTitleContext || track.sourceTitleContext});if(JSON.stringify(next)!==JSON.stringify(track))updates.set(track,next)}
      else {
        // Search-only queue entries need not exist in the library database.
        const detail = await getVideoParts(track.source.bvid, false, { background: true }).catch(() => null)
        if (epoch !== accountEpoch()) return
        const part = detail?.parts.find(part => part.cid === track.source.cid)
        if (detail && part) {
          const canonical = toTrack(detail, part), original = sourceTrack(track)
          const imageKey = (value?: string) => value?.replace(/^(?:https?:)?\/\//, '')
          const coverUrl = !original.coverUrl || part.firstFrameUrl && imageKey(original.coverUrl) === imageKey(part.firstFrameUrl) ? canonical.coverUrl : original.coverUrl
          const next = withTrackTitle({...original, coverUrl, durationSeconds: original.durationSeconds || canonical.durationSeconds, sourceTitleContext:canonical.sourceTitleContext, videoTitle:canonical.videoTitle, partCount:canonical.partCount})
          if(JSON.stringify(next)!==JSON.stringify(track))updates.set(track,next)
        }
      }
    }
    if (updates.size) usePlayerStore.setState(state => ({queue:state.queue.map(track => expected.has(track) ? updates.get(track)||track : track),current:state.current ? expected.has(state.current) ? updates.get(state.current)||state.current : state.current : null}))
    if (pending.length || changed) await Promise.all(['listening-statistics','library','home-recent','list-preferences'].map(key => client.invalidateQueries({queryKey:[key]})))

  }
}
