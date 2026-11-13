// Interpolate only after the media clock actually advances. A native player can
// intend to play while still waiting for bytes; that is not a running clock.
export type ClockSample = { id?: string; position?: number; status?: string; rate?: number; duration?: number; revision?: number; advancing?: boolean; seekRevision?: number }
export function createNativeClock() {
  let sample: ClockSample = {}, at = 0, advancing = false, horizon = .65
  return {
    update(next: ClockSample, now: number) {
      if (!Number.isFinite(next.position)) { if (next.status !== 'playing') advancing = false; return }
      const elapsed = (now - at) / 1000
      const delta = next.position! - (sample.position ?? next.position!)
      const continuous = next.id === sample.id && next.revision === sample.revision && next.seekRevision === sample.seekRevision && elapsed > 0 && elapsed < 2
      if (continuous && delta > .01) horizon = Math.min(1.25, Math.max(.65, elapsed * 1.3))
      advancing = next.status === 'playing' && (next.advancing ?? (continuous && delta > .01 && delta < elapsed * Math.max(1, next.rate ?? 1) + .4))
      sample = next; at = now
    },
    position(now: number) {
      const position = Math.max(0, sample.position ?? 0) + (advancing ? Math.min(horizon, Math.max(0, now - at) / 1000) * (sample.rate ?? 1) : 0)
      return sample.duration && sample.duration > 0 ? Math.min(sample.duration, position) : position
    },
  }
}
