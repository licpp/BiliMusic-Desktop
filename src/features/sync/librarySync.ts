import type { QueryClient } from '@tanstack/react-query'
import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { startBackgroundSync } from '../../services/backgroundSync'
import { inDesktopShell, fromStoredTrack } from '../../services/desktopApi'
import { hydrateSources } from '../../services/sourceHydration'
import { getSyncedTrack, syncNow, syncStatus } from '../../services/sync'
import { syncErrorMessage } from '../../services/userErrors'
import { usePlayerStore } from '../player/playerStore'

export async function refreshSyncedLibrary(client: QueryClient) {
  const epoch = accountEpoch()
  window.dispatchEvent(new Event('bilimusic-library-synced'))
  await Promise.all(['library', 'playlists', 'home-recent', 'collections', 'collection-progress', 'linked-bili-folder','list-preferences'].map((key) => client.invalidateQueries({ queryKey: [key] })))
  if (epoch !== accountEpoch()) return
  const current = usePlayerStore.getState().current
  if (current) {
    const stored = await getSyncedTrack(current.id)
    if (stored && epoch === accountEpoch()) usePlayerStore.getState().updateTrack(fromStoredTrack(stored))
  }
}
export function startCloudSync(client: QueryClient) {
  if (!inDesktopShell) return () => undefined
  let refreshing = false
  const manualRefresh = async () => {
    if (refreshing) return
    refreshing = true
    const epoch = accountEpoch()
    window.dispatchEvent(new CustomEvent('bilimusic-sync-status', {detail:'正在刷新…'}))
    try {
      await client.invalidateQueries({refetchType:'active'})
      if (epoch !== accountEpoch()) return
      const status=await syncStatus()
      if(epoch!==accountEpoch())return
      if (status.config.enabled) {
        const result = await syncNow()
        if (epoch !== accountEpoch()) return
        if (result.changed) await refreshSyncedLibrary(client)
        if (result.conflicts.length) {window.dispatchEvent(new CustomEvent('bilimusic-sync-status',{detail:'有同步差异，请到云同步中处理'}));return}
      }
      window.dispatchEvent(new CustomEvent('bilimusic-sync-status',{detail:'已刷新'}))
    } catch (error) { if(epoch === accountEpoch()) window.dispatchEvent(new CustomEvent('bilimusic-sync-status',{detail:syncErrorMessage(error)})) }
    finally {refreshing=false}
  }
  window.addEventListener('bilimusic-refresh-requested',manualRefresh)
  const stop = startBackgroundSync(client, async (outcome, epoch) => {
    if (outcome.conflicts.length) {
      window.dispatchEvent(new CustomEvent('bilimusic-sync-status', { detail: '有同步冲突，请到设置中处理' }))
      return
    }
    if (outcome.changed) {
      await refreshSyncedLibrary(client)
      void hydrateSources(epoch)
        .then(loaded => { if (loaded && epoch === accountEpoch()) return refreshSyncedLibrary(client) })
        .catch(() => undefined)
    }
  })
  return () => {stop();window.removeEventListener('bilimusic-refresh-requested',manualRefresh)}
}

export async function hydrateVisibleTracks(tracks: Track[] | undefined, client: QueryClient) {
  if (!inDesktopShell || !tracks?.length) return
  const ids = tracks.filter((t) => t.source.provider === 'bilibili' && !t.durationSeconds).slice(0, 10).map((t) => t.id)
  if (!ids.length) return
  const epoch = accountEpoch()
  const changed = await hydrateSources(epoch, { trackIds: ids })
  if (changed && epoch === accountEpoch()) await refreshSyncedLibrary(client)
}
