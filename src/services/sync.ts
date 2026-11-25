import { invoke } from '@tauri-apps/api/core'
import type { StoredTrack } from '../domain/library'
import { accountEpoch } from './accountScope'
import { reportSyncOutcome, reportSyncError } from './syncAttention'

export type SyncConfig = { enabled: boolean; provider: 'cloud' | 'webdav'; uid: string; url: string; history: boolean; statistics: boolean; initialized: boolean; deviceId: string }
export type TrackRepairPreview = {
  revision: string
  total: number
  entries: { kind: 'favorite' | 'playlist' | 'history'; label: string; trackId: string }[]
}
export type SyncStatus = { visibilityError?:string; importError?:string; chaptersError?:string; favoriteOrderError?:string; localError?:string; trackRepair?: TrackRepairPreview | null; config: SyncConfig; lastSuccess?: string; records: number; bytes: number }
export type SyncConflict = { key: string; field: string; local: unknown; remote: unknown }
export type SyncOutcome = { conflicts: SyncConflict[]; records: number; bytes: number; changed: boolean; skipped?: boolean; visibilityError?: string; importError?: string; chaptersError?: string; favoriteOrderError?: string }
export const defaultSyncConfig: SyncConfig = { enabled: false, provider: 'webdav', uid: '', url: 'https://dav.jianguoyun.com/dav/', history: false, statistics: false, initialized: false, deviceId: '' }
export const syncStatus = () => invoke<SyncStatus>('sync_status')
export async function syncNow(preview = false, resolution?: string, automatic = false) {
  const epoch = accountEpoch()
  try {
    const result = await invoke<SyncOutcome>('sync_now', { preview, resolution, automatic })
    if (epoch === accountEpoch()) reportSyncOutcome(result, preview)
    return result
  } catch (error) {
    if (epoch === accountEpoch()) reportSyncError('library', true, error)
    throw error
  }
}

export const getSyncedTrack = (trackId: string) => invoke<StoredTrack | null>('sync_current_track', { trackId })
