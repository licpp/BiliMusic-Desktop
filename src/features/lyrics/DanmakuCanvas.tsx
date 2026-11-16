import { danmakuX, layoutDanmaku, type DanmakuPlacement } from './danmakuLayout'
import { memo, useEffect, useRef } from 'react'
import type { DanmakuItem } from '../../domain/bilibili'
import { playbackClock, usePlayerStore } from '../player/playerStore'

export const DanmakuCanvas = memo(function DanmakuCanvas({ items, scale, opacity, density }: { items: DanmakuItem[]; scale: number; opacity: number; density: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const stride = Math.max(1, Math.round(1 / Math.max(.125, Math.min(1, density))))
    const sorted = items
      .filter(item => item.mode >= 1 && item.mode <= 6)
      .sort((a, b) => a.timeSeconds - b.timeSeconds)
      .filter((_, index) => index % stride === 0)
    const sprites = new Map<number, { canvas: HTMLCanvasElement; width: number; height: number }>()
    let width = 0, height = 0, ratio = 1, frame = 0
    let placements: DanmakuPlacement[] = []
    const measure = (item: DanmakuItem) => {
      const font = Math.max(12, Math.min(56, item.fontSize * scale))
      context.font = `600 ${font}px system-ui, sans-serif`
      return { width: Math.min(context.measureText(item.text.slice(0, 120)).width + 8, Math.max(640, width * 2)), height: font * 1.4 }
    }
    const draw = () => {
      context.clearRect(0, 0, width, height)
      context.globalAlpha = opacity
      const time = playbackClock()
      let low = 0, high = placements.length
      while (low < high) { const middle = (low + high) >>> 1; if (placements[middle].time <= time) low = middle + 1; else high = middle }
      let visible = 0
      for (let at = Math.max(0, low - 100); at < low && visible < 40; at++) {
        const placement = placements[at], index = placement.index
        const item = sorted[index], age = time - item.timeSeconds
        if (age > 8) continue
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
        context.drawImage(sprite.canvas, danmakuX(placement, time, width), placement.y, sprite.width, sprite.height); visible++
      }
    }
    const tick = () => { frame = 0; if (document.hidden) return; draw(); if (usePlayerStore.getState().status === 'playing') frame = requestAnimationFrame(tick) }
    const schedule = () => { if (!frame && !document.hidden) frame = requestAnimationFrame(tick) }
    const resize = () => {
      // Use the CSS layout box, not the transformed viewport bounding rectangle.
      // Rotation/viewport transitions must not stretch a portrait backing buffer into landscape.
      const nextWidth = canvas.clientWidth, nextHeight = canvas.clientHeight
      const nextRatio = Math.min(window.devicePixelRatio || 1, 2)
      if (!nextWidth || !nextHeight) return
      if (nextWidth === width && nextHeight === height && nextRatio === ratio) return
      width = nextWidth; height = nextHeight; ratio = nextRatio
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
      context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0)
      sprites.clear(); placements = layoutDanmaku(sorted, width, height, density, measure); schedule()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)
    screen.orientation?.addEventListener('change', resize)
    resize()
    const unsubscribe = usePlayerStore.subscribe(schedule)
    document.addEventListener('visibilitychange', schedule)
    schedule()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); screen.orientation?.removeEventListener('change', resize); unsubscribe(); document.removeEventListener('visibilitychange', schedule); sprites.clear() }
  }, [items, scale, opacity, density])
  return <canvas ref={ref} className="danmaku-canvas" aria-label="弹幕" />
})
