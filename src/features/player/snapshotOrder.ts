import type { NativeAudioState } from './contracts'

/** Sequence numbers belong to a driver instance, never to the whole app lifetime. */
export function createSnapshotOrder() {
  let latest: NativeAudioState | undefined
  const retired = new Set<string>()
  return {
    get latest() { return latest },
    retireIfCurrent(observed: NativeAudioState | undefined) {
      if (latest !== observed) return false
      if (latest?.engineInstanceId) retired.add(latest.engineInstanceId)
      latest = undefined
      return true
    },
    accept(next: NativeAudioState) {
      if (latest?.engineInstanceId && !next.engineInstanceId) return false
      if (next.engineInstanceId && retired.has(next.engineInstanceId)) return false
      if (latest?.engineInstanceId && next.engineInstanceId !== latest.engineInstanceId) {
        retired.add(latest.engineInstanceId)
        latest = undefined
      }
      if(next.action && next.revision === undefined && next.sourceRevision === undefined && next.sequence === undefined) return !latest?.engineInstanceId
      const revision = next.sourceRevision ?? next.revision ?? 0
      const previous = latest?.sourceRevision ?? latest?.revision ?? 0
      if (latest && (revision < previous || revision === previous && next.sequence !== undefined && next.sequence < (latest.sequence ?? 0))) return false
      // Older players emit commands without clock fields. They must not replace
      // the authoritative sample or reset its media clock.
      if (!next.action) latest = next
      return true
    },
  }
}
