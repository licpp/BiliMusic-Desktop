export type TouchDirection = 'pending' | 'vertical' | 'horizontal' | 'edge'
export function touchDirection(x: number, y: number, startX: number, startY: number, previous: TouchDirection = 'pending'): TouchDirection {
  if (previous !== 'pending') return previous
  const dx = Math.abs(x - startX), dy = Math.abs(y - startY)
  if (Math.max(dx, dy) < 10) return 'pending'
  if (dx > dy * 1.2) return startX < 24 ? 'edge' : 'horizontal'
  if (dy > dx * 1.2) return 'vertical'
  return 'pending'
}
