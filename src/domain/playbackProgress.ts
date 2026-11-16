export function progressAtPointer(x: number, left: number, width: number, duration: number) {
  if (![x, left, width, duration].every(Number.isFinite) || width <= 0 || duration <= 0) return 0
  return Math.max(0, Math.min(1, (x - left) / width)) * duration
}
