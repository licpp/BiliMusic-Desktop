import { memo, useEffect, useRef } from 'react'
import type { DanmakuItem } from '../../services/desktopApi'
import { playbackClock, usePlayerStore } from '../player/playerStore'

export const DanmakuCanvas = memo(function DanmakuCanvas({ items, scale, opacity }: { items: DanmakuItem[]; scale: number; opacity: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const sorted = items.filter((item) => [1, 2, 3, 4, 5, 6].includes(item.mode)).slice().sort((a, b) => a.timeSeconds - b.timeSeconds)
    const sprites = new Map<number, { canvas: HTMLCanvasElement; width: number; height: number }>()
    let width = 0, height = 0, ratio = 1, frame = 0
    const draw = () => {
      context.clearRect(0, 0, width, height)
      context.globalAlpha = opacity
      const time = playbackClock()
      let low = 0, high = sorted.length
      while (low < high) { const middle = (low + high) >>> 1; if (sorted[middle].timeSeconds <= time) low = middle + 1; else high = middle }
      let visible = 0
      for (let index = low - 1; index >= Math.max(0, low - 100) && visible < 40; index--) {
        const item = sorted[index], age = time - item.timeSeconds
        if (age > 8) break
        const fixed = item.mode === 4 || item.mode === 5
        if (fixed && age > 4) continue
        let sprite = sprites.get(index)
        if (!sprite) {
          const font = Math.max(12, Math.min(56, item.fontSize * scale))
          const text = item.text.slice(0, 120)
          context.font = `600 ${font}px system-ui, sans-serif`
          const textWidth = Math.min(context.measureText(text).width + 8, Math.max(640, width * 2)), textHeight = font * 1.4
          const image = document.createElement('canvas'); image.width = Math.ceil(textWidth * ratio); image.height = Math.ceil(textHeight * ratio)
          const paint = image.getContext('2d')!
          paint.scale(ratio, ratio); paint.font = context.font; paint.textBaseline = 'top'; paint.lineWidth = 3; paint.strokeStyle = '#000a'; paint.strokeText(text, 4, 2); paint.fillStyle = `#${item.color.toString(16).padStart(6, '0')}`; paint.fillText(text, 4, 2)
          sprite = { canvas: image, width: textWidth, height: textHeight }; sprites.set(index, sprite)
          if (sprites.size > 80) sprites.delete(sprites.keys().next().value!)
        }
        const lanes = Math.max(1, Math.floor(height * .8 / sprite.height))
        const y = item.mode === 4 ? height - sprite.height * (1 + index % Math.min(3, lanes)) : 8 + (index % lanes) * sprite.height
        const x = fixed ? (width - sprite.width) / 2 : item.mode === 6 ? -sprite.width + (width + sprite.width) * age / 8 : width - (width + sprite.width) * age / 8
        context.drawImage(sprite.canvas, x, y, sprite.width, sprite.height); visible++
      }
    }
    const tick = () => { frame = 0; if (document.hidden) return; draw(); if (usePlayerStore.getState().status === 'playing') frame = requestAnimationFrame(tick) }
    const schedule = () => { if (!frame && !document.hidden) frame = requestAnimationFrame(tick) }
    const observer = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height; ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); context.setTransform(ratio, 0, 0, ratio, 0, 0); sprites.clear(); schedule()
    })
    observer.observe(canvas)
    const unsubscribe = usePlayerStore.subscribe(schedule)
    document.addEventListener('visibilitychange', schedule)
    schedule()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); unsubscribe(); document.removeEventListener('visibilitychange', schedule); sprites.clear() }
  }, [items, scale, opacity])
  return <canvas ref={ref} className="danmaku-canvas" aria-label="弹幕" />
})
