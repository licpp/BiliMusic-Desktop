import { invoke } from '@tauri-apps/api/core'
import type { QueryClient } from '@tanstack/react-query'
import { usePlayerStore } from '../features/player/playerStore'
import { inDesktopShell, fromStoredTrack, type StoredTrack } from './desktopApi'
import { accountEpoch } from './accountScope'
const attempted = new Map<string, number>()
export async function hydrateSourceTitles(ids: string[], client: QueryClient) {
  if (!inDesktopShell) return
  const epoch = accountEpoch(), now = Date.now()
  const pending: string[] = []
  for (const id of new Set(ids)) {
    const key = `${epoch}:${id}`
    if ((attempted.get(key) || 0) > now - 300_000) continue
    attempted.set(key, now); pending.push(id)
    if (pending.length === 50) break
  }
  if (attempted.size > 1000) for (const [key, time] of attempted) if (time < now - 300_000) attempted.delete(key)
  let changed = 0
  for (let i = 0; i < pending.length && epoch === accountEpoch(); i += 8) {
    try { changed += await invoke<number>('sync_hydrate_sources', { titleIds: pending.slice(i, i + 8) }) }
    catch { break } // Metadata failure never blocks playback or hides the cached name.
  }
  if (changed && epoch === accountEpoch()) {
    for (const track of usePlayerStore.getState().queue.filter(track => pending.includes(track.id))) {
      const stored = await invoke<StoredTrack | null>('sync_current_track', {trackId:track.id}).catch(() => null)
      if (epoch !== accountEpoch()) return
      if (stored) usePlayerStore.getState().updateTrack({...track,...fromStoredTrack(stored)})
    }
    await Promise.all(['listening-statistics','library','home-recent','list-preferences'].map(key => client.invalidateQueries({queryKey:[key]})))
  }
}
