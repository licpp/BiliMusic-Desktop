import type { DanmakuItem } from '../../domain/bilibili'

export type DanmakuPlacement = { index: number; time: number; end: number; mode: number; y: number; width: number; height: number }
const padding = 8, gap = 12
export function danmakuX(item: DanmakuPlacement, time: number, width: number) {
  if (item.mode === 4 || item.mode === 5) return (width - item.width) / 2
  const distance = (width + item.width) * (time - item.time) / 8
  return item.mode === 6 ? -item.width + distance : width - distance
}
function fits(previous: DanmakuPlacement, next: DanmakuPlacement, width: number) {
  if (previous.end <= next.time) return true
  if (previous.mode === 4 || previous.mode === 5 || next.mode === 4 || next.mode === 5 || (previous.mode === 6) !== (next.mode === 6)) return false
  const elapsed = next.time - previous.time
  const previousSpeed = (width + previous.width) / 8, nextSpeed = (width + next.width) / 8
  // The preceding tail must have entered the screen; a faster follower must
  // not catch it before it leaves. The same distances apply in either direction.
  return previousSpeed * elapsed >= previous.width + gap &&
    (nextSpeed <= previousSpeed || width - nextSpeed * (previous.end - next.time) >= gap)
}
export function layoutDanmaku(items: DanmakuItem[], width: number, height: number, density: number, measure: (item: DanmakuItem) => { width: number; height: number }) {
  if (width <= 0 || height <= 0 || !items.length) return []
  const metrics = items.map(measure), rowHeight = metrics.reduce((max, m) => Math.max(max, m.height), 1)
  const fraction = Math.max(.125, Math.min(1, density))
  const bottomCount = items.some(i => i.mode === 4) ? Math.min(3, Math.max(1, Math.floor(height * .2 / rowHeight))) : 0
  const topHeight = Math.min(height * .8, height - padding * 2 - bottomCount * rowHeight)
  const topCount = Math.max(1, Math.floor(topHeight * fraction / rowHeight))
  const top: DanmakuPlacement[][] = Array.from({ length: topCount }, () => [])
  const bottom: DanmakuPlacement[][] = Array.from({ length: bottomCount }, () => [])
  const result: DanmakuPlacement[] = []
  items.forEach((item, index) => {
    const fixed = item.mode === 4 || item.mode === 5
    const next = { index, time: item.timeSeconds, end: item.timeSeconds + (fixed ? 4 : 8), mode: item.mode, y: 0, ...metrics[index] }
    const lanes = item.mode === 4 ? bottom : top
    for (let lane = 0; lane < lanes.length; lane++) {
      lanes[lane] = lanes[lane].filter(p => p.end > next.time)
      if (!lanes[lane].every(p => fits(p, next, width))) continue
      next.y = item.mode === 4 ? height - padding - (lane + 1) * rowHeight : padding + lane * rowHeight
      lanes[lane].push(next); result.push(next); break
    }
  })
  return result
}
