import { startBackgroundSync } from './backgroundSync'
import { accountEpoch } from './accountScope'
import { reportSyncOutcome, reportSyncError } from './syncAttention'
import { invoke } from '@tauri-apps/api/core'
import { inDesktopShell, fromStoredTrack } from './desktopApi'
import type { QueryClient } from '@tanstack/react-query'
import { usePlayerStore } from '../features/player/playerStore'
export type SyncConfig = { enabled: boolean; provider: 'cloud' | 'webdav'; uid: string; url: string; history: boolean; statistics: boolean; initialized: boolean; deviceId: string }
export type SyncStatus = { config: SyncConfig; lastSuccess?: string; records: number; bytes: number }
export type SyncConflict = { key: string; field: string; local: unknown; remote: unknown }
export type SyncOutcome = { conflicts: SyncConflict[]; records: number; bytes: number; changed: boolean }
export const defaultSyncConfig: SyncConfig = { enabled: false, provider: 'webdav', uid: '', url: 'https://dav.jianguoyun.com/dav/', history: false, statistics: false, initialized: false, deviceId: '' }
export const syncStatus = () => invoke<SyncStatus>('sync_status')
export async function syncNow(preview = false, resolution?: string, automatic = false) {
  const epoch = accountEpoch()
  try {
    const result = await invoke<SyncOutcome>('sync_now', { preview, resolution, automatic })
    if (epoch === accountEpoch()) reportSyncOutcome(result, preview)
    return result
  } catch (error) {
    if (epoch === accountEpoch()) reportSyncError('library', true)
    throw error
  }
}
export async function refreshSyncedLibrary(client: QueryClient) {
  const epoch = accountEpoch()
  await Promise.all(['library', 'playlists', 'home-recent', 'collections', 'collection-progress', 'linked-bili-folder','list-preferences'].map((key) => client.invalidateQueries({ queryKey: [key] })))
  if (epoch !== accountEpoch()) return
  const current = usePlayerStore.getState().current
  if (current) {
    const stored = await invoke<import('./desktopApi').StoredTrack | null>('sync_current_track', { trackId: current.id })
    if (stored && epoch === accountEpoch()) usePlayerStore.getState().updateTrack(fromStoredTrack(stored))
  }
}
export function startCloudSync(client: QueryClient) {
  if (!inDesktopShell) return () => undefined
  return startBackgroundSync(client, async outcome => {
    if (outcome.conflicts.length) {
      window.dispatchEvent(new CustomEvent('bilimusic-sync-status', { detail: '有同步冲突，请到设置中处理' }))
      return
    }
    if (outcome.changed) {
      await refreshSyncedLibrary(client)
      const epoch = accountEpoch()
      const loaded = await invoke<number>('sync_hydrate_sources')
      if (loaded && epoch === accountEpoch()) await refreshSyncedLibrary(client)
    }
  })
}

export async function hydrateVisibleTracks(tracks: import('../domain/track').Track[] | undefined, client: QueryClient) {
  if (!inDesktopShell || !tracks?.length) return
  const ids = tracks.filter((t) => t.source.provider === 'bilibili' && !t.durationSeconds).slice(0, 10).map((t) => t.id)
  if (!ids.length) return
  const changed = await invoke<number>('sync_hydrate_sources', { trackIds: ids })
  if (changed) await refreshSyncedLibrary(client)
}
