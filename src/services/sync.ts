import { invoke } from '@tauri-apps/api/core'
import { inDesktopShell, fromStoredTrack } from './desktopApi'
import type { QueryClient } from '@tanstack/react-query'
import { usePlayerStore } from '../features/player/playerStore'
export type SyncConfig = { enabled: boolean; provider: 'cloud' | 'webdav'; uid: string; url: string; history: boolean; initialized: boolean; deviceId: string }
export type SyncStatus = { config: SyncConfig; lastSuccess?: string; records: number; bytes: number }
export type SyncConflict = { key: string; field: string; local: unknown; remote: unknown }
export type SyncOutcome = { conflicts: SyncConflict[]; records: number; bytes: number; changed: boolean }
export const defaultSyncConfig: SyncConfig = { enabled: false, provider: 'webdav', uid: '', url: 'https://dav.jianguoyun.com/dav/', history: false, initialized: false, deviceId: '' }
export const syncStatus = () => invoke<SyncStatus>('sync_status')
export const syncNow = (preview = false, resolution?: 'local' | 'remote', automatic = false) => invoke<SyncOutcome>('sync_now', { preview, resolution, automatic })
export async function refreshSyncedLibrary(client: QueryClient) {
  await Promise.all(['library', 'playlists', 'home-recent'].map((key) => client.invalidateQueries({ queryKey: [key] })))
  const current = usePlayerStore.getState().current
  if (current) {
    const stored = await invoke<import('./desktopApi').StoredTrack | null>('sync_current_track', { trackId: current.id })
    if (stored) usePlayerStore.getState().updateTrack(fromStoredTrack(stored))
  }
}
export function startCloudSync(client: QueryClient) {
  if (!inDesktopShell) return () => undefined
  let busy = false, stopped = false, failures = 0, blocked = false
  let nextAllowed = 0, timer = 0
  const run = async () => {
    if (stopped || busy || blocked || document.hidden || Date.now() < nextAllowed) return
    busy = true
    try {
      const status = await syncStatus()
      if (stopped || !status.config.enabled || !status.config.initialized) return
      const outcome = await syncNow(false, undefined, true)
      if (outcome.conflicts.length) { blocked = true; window.dispatchEvent(new CustomEvent('bilimusic-sync-status', { detail: '有同步冲突，请到设置中处理' })); return }
      failures = 0; nextAllowed = Date.now() + 30_000
      if (outcome.changed) await refreshSyncedLibrary(client)
      const loaded = await invoke<number>('sync_hydrate_sources')
      if (loaded) await refreshSyncedLibrary(client)
      window.dispatchEvent(new CustomEvent('bilimusic-sync-status', { detail: '' }))
    } catch {
      failures++; nextAllowed = Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(failures, 6))
      window.dispatchEvent(new CustomEvent('bilimusic-sync-status', { detail: '同步暂未完成，请到设置中查看或手动重试' }))
    } finally { busy = false }
  }
  const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void run(), 10_000) }
  const reconfigure = () => { blocked = false; nextAllowed = 0; failures = 0; schedule() }
  const foreground = () => { if (!document.hidden) void run() }
  window.addEventListener('bilimusic-data-changed', schedule)
  window.addEventListener('bilimusic-sync-configured', reconfigure)
  document.addEventListener('visibilitychange', foreground)
  const interval = window.setInterval(() => void run(), 180_000)
  schedule()
  return () => { stopped = true; window.clearTimeout(timer); window.clearInterval(interval); window.removeEventListener('bilimusic-data-changed', schedule); window.removeEventListener('bilimusic-sync-configured', reconfigure); document.removeEventListener('visibilitychange', foreground) }
}

export async function hydrateVisibleTracks(tracks: import('../domain/track').Track[] | undefined, client: QueryClient) {
  if (!inDesktopShell || !tracks?.length) return
  const ids = tracks.filter((t) => !t.durationSeconds).slice(0, 10).map((t) => t.id)
  if (!ids.length) return
  const changed = await invoke<number>('sync_hydrate_sources', { trackIds: ids })
  if (changed) await refreshSyncedLibrary(client)
}
