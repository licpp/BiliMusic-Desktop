import type { PersistStorage, StorageValue } from 'zustand/middleware'
import { packQueueBase } from '../../domain/contentVisibility'
import type { Track } from '../../domain/track'
import { isOfflineVideoRow } from './offlinePlayback'

type SnapshotQueue = { queueBase?: Track[]; queue: Track[]; current: Track | null; offlineQueue?: boolean }

function queueForOfflineSnapshot(queue: Track[], base: Track[]) {
  const baseById = new Map(base.map(track => [track.id, track]))
  return queue.flatMap(track => {
    const original = baseById.get(track.id)
    // A downloaded first part may have the same ID as its unresolved video.
    return original ? [isOfflineVideoRow(original) ? original : track] : []
  })
}

export function createPlayerSnapshotStorage<Draft extends SnapshotQueue>() {
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSnapshot: { key: string; value: StorageValue<Draft> } | undefined
  let snapshotQueue: Track[] | undefined
  let snapshotCurrent: string | undefined

  function flush() {
    clearTimeout(persistTimer)
    persistTimer = undefined
    const pending = pendingSnapshot
    pendingSnapshot = undefined
    if (!pending) return

    const { queueBase, offlineQueue, ...state } = pending.value.state
    const base = queueBase ?? state.queue
    const queue = offlineQueue ? queueForOfflineSnapshot(state.queue, base) : state.queue
    const saved = { ...state, ...packQueueBase(queue, base), queue }
    try {
      localStorage.setItem(pending.key, JSON.stringify({ state: saved, version: pending.value.version }))
    } catch { /* Playback remains usable when storage is full. */ }
  }

  const storage: PersistStorage<Draft> = {
    getItem(key) {
      const value = localStorage.getItem(key)
      return value === null ? null : JSON.parse(value)
    },
    setItem(key, value) {
      const { queue, current } = value.state
      const urgent = queue !== snapshotQueue || current?.id !== snapshotCurrent
      snapshotQueue = queue
      snapshotCurrent = current?.id
      pendingSnapshot = { key, value }
      if (urgent) flush()
      else persistTimer ??= setTimeout(flush, 1000)
    },
    removeItem(key) {
      if (pendingSnapshot?.key === key) {
        clearTimeout(persistTimer)
        persistTimer = undefined
        pendingSnapshot = undefined
      }
      localStorage.removeItem(key)
    },
  }
  return { storage, flush }
}
