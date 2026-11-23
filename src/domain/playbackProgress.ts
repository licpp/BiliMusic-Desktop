export function progressAtPointer(x: number, left: number, width: number, duration: number) {
  if (![x, left, width, duration].every(Number.isFinite) || width <= 0 || duration <= 0) return 0
  return Math.max(0, Math.min(1, (x - left) / width)) * duration
}

export function progressAtPointerInRect(x: number, y: number, rect: { left: number; top: number; width: number; height: number }, duration: number) {
  // On phones fullscreen can rotate clockwise while the viewport remains in portrait.
  if (rect.height > rect.width) return progressAtPointer(y, rect.top, rect.height, duration)
  return progressAtPointer(x, rect.left, rect.width, duration)
}
