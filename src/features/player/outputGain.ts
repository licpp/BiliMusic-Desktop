// Apply the Rust gain plan within the player volume range, then apply ducking.
export function safeGainDb(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(-80, Math.min(6, value)) : 0
}
export function outputVolume(volume: number, gainDb: number, duck = 1): number {
  const normalized = Math.max(0, Math.min(1, volume)) * Math.pow(10, safeGainDb(gainDb) / 20)
  return Math.min(1, normalized) * Math.max(0, Math.min(1, duck))
}
export function createOutputGain(now = () => performance.now()) {
  let from = 0, target = 0, began = 0
  const current = () => from + (target - from) * Math.min(1, Math.max(0, (now() - began) / 300))
  return {
    current,
    set(gainDb: number, smooth = false) { from = smooth ? current() : safeGainDb(gainDb); target = safeGainDb(gainDb); began = now() },
    active: () => now() < began + 300 && from !== target,
  }
}
