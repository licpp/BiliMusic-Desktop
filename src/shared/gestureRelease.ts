export const gestureSlop = 10

export function trackSwipeDirection(distance: number, elapsed: number) {
  return Math.abs(distance) >= 54 || (Math.abs(distance) >= 24 && Math.abs(distance) / Math.max(1, elapsed) >= .48)
    ? Math.sign(distance) : 0
}

export function dragDismissDirection(distance: number, elapsed: number) {
  return Math.abs(distance) >= 64 || (Math.abs(distance) >= 28 && Math.abs(distance) / Math.max(1, elapsed) >= .55)
    ? Math.sign(distance) : 0
}

export function navigationSwipeDirection(distance: number, elapsed: number, edge: boolean, width = 393) {
  if (edge && distance <= 0) return 0
  const length = Math.abs(distance)
  const threshold = Math.max(48, width * (edge ? .23 : .22))
  return length >= threshold || (length >= 24 && length / Math.max(1, elapsed) >= .5) ? Math.sign(distance) : 0
}

export function swipeAxis(dx: number, dy: number) {
  if (Math.abs(dx) >= gestureSlop && Math.abs(dx) > Math.abs(dy) * 1.2) return 'horizontal'
  if (Math.abs(dy) >= gestureSlop && Math.abs(dy) > Math.abs(dx) * 1.2) return 'vertical'
}
export function edgeSwipeOffset(distance: number, width: number) {
  return Math.min(width, Math.max(0, distance - gestureSlop))
}

export function edgeBackDirection(distance: number, width: number, velocity: number) {
  return Number(distance >= Math.max(48, width * .23) || (distance >= 24 && velocity >= .5))
}

export function edgeBackTiming(remaining: number, width: number, velocity = 0) {
  const fraction = Math.min(1, Math.abs(remaining) / Math.max(1, width))
  const speed = Math.max(0, Math.sign(remaining) * velocity)
  return {
    duration: Math.round(Math.max(190, 200 + 155 * Math.sqrt(fraction) - Math.min(95, 48 * speed))),
    easing: 'cubic-bezier(.22,.36,.24,1)',
  }
}
