import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { accountEpoch } from '../../services/accountScope'
import { isOHOS } from '../../services/platform'
import type { Track } from '../../domain/track'

type OfflineLibrary = { byId: ReadonlyMap<string, Track>; byVideo: ReadonlyMap<string, Track[]> }
export const useOfflinePlayback = create<{ offline: boolean; library: OfflineLibrary | null }>(() => ({
  offline: false,
  library: null,
}))

export function indexOfflineTracks(tracks: Track[]): OfflineLibrary {
  const byVideo = new Map<string, Track[]>()
  for (const track of tracks) {
    const parts = byVideo.get(track.source.bvid) ?? []
    parts.push(track)
    byVideo.set(track.source.bvid, parts)
  }
  for (const parts of byVideo.values()) parts.sort((a, b) => a.source.page - b.source.page)
  return { byId: new Map(tracks.map(track => [track.id, track])), byVideo }
}

export const isOfflineVideoRow = (track: Track) => track.resolveParts === true || track.source.cid <= 0

export function offlineUnavailable(track: Track, state = useOfflinePlayback.getState(), videoRow = isOfflineVideoRow(track)) {
  if (!state.offline) return false
  return videoRow
    ? !state.library?.byVideo.has(track.source.bvid)
    : !state.library?.byId.has(track.id)
}

export function offlineEntries(track: Track, state = useOfflinePlayback.getState()): Track[] {
  if (!state.offline) return [track]
  if (offlineUnavailable(track, state)) return []
  if (!isOfflineVideoRow(track)) return [track]
  return state.library?.byVideo.get(track.source.bvid) ?? []
}

let pending: Promise<void> | undefined
export const waitForOfflineLibrary = () => pending

export function startOfflinePlayback(load: () => Promise<Track[]>) {
  let revision = 0
  let changingAccount = false
  let disposed = false
  const refresh = () => {
    if (changingAccount || disposed) return
    const epoch = accountEpoch(), request = ++revision
    const current = () => request === revision && epoch === accountEpoch()
    const update = (offline: boolean) => {
      if (!current()) return
      if (!offline) {
        pending = undefined
        useOfflinePlayback.setState({ offline, library: null })
        return
      }
      useOfflinePlayback.setState({ offline })
      pending = load().then(tracks => {
        if (current()) useOfflinePlayback.setState({ library: indexOfflineTracks(tracks) })
      }).catch(() => undefined)
    }
    if (isOHOS) {
      // ArkWeb can report offline even when HarmonyOS has a usable default network.
      void invoke<boolean>('plugin:ohos-player|control', { action: 'networkOnline' })
        .then(online => update(online === false), () => update(navigator.onLine === false))
    } else {
      update(navigator.onLine === false)
    }
  }
  const accountChanging = () => {
    changingAccount = true
    revision++
    pending = undefined
    useOfflinePlayback.setState({ library: null })
  }
  const accountChanged = () => {
    changingAccount = false
    refresh()
  }
  const visibilityChanged = () => {
    if (!document.hidden && (isOHOS || navigator.onLine === false || useOfflinePlayback.getState().offline)) refresh()
  }
  const handlers = {
    online: refresh,
    offline: refresh,
    'bilimusic-account-changing': accountChanging,
    'bilimusic-account-changed': accountChanged,
    'bilimusic-offline-files-changed': refresh,
    'bilimusic-library-synced': refresh,
  }
  for (const [type, handler] of Object.entries(handlers)) window.addEventListener(type, handler)
  document.addEventListener('visibilitychange', visibilityChanged)
  refresh()
  return () => {
    if (disposed) return
    disposed = true
    ++revision
    pending = undefined
    for (const [type, handler] of Object.entries(handlers)) window.removeEventListener(type, handler)
    document.removeEventListener('visibilitychange', visibilityChanged)
  }
}
