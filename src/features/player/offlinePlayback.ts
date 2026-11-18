import { create } from 'zustand'
import { accountEpoch } from '../../services/accountScope'
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
  const refresh = () => {
    if (changingAccount) return
    const offline = navigator.onLine === false
    const epoch = accountEpoch(), request = ++revision
    if (!offline) {
      pending = undefined
      useOfflinePlayback.setState({ offline, library: null })
      return
    }
    useOfflinePlayback.setState({ offline })
    pending = load().then(tracks => {
      if (request === revision && epoch === accountEpoch()) useOfflinePlayback.setState({ library: indexOfflineTracks(tracks) })
    }).catch(() => undefined)
  }
  window.addEventListener('online', refresh)
  window.addEventListener('offline', refresh)
  window.addEventListener('bilimusic-account-changing', () => {
    changingAccount = true
    revision++
    pending = undefined
    useOfflinePlayback.setState({ library: null })
  })
  window.addEventListener('bilimusic-account-changed', () => {
    changingAccount = false
    refresh()
  })
  window.addEventListener('bilimusic-offline-files-changed', refresh)
  window.addEventListener('bilimusic-library-synced', refresh)
  document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine === false) refresh() })
  refresh()
}
