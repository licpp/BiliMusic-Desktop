import type { LyricLine } from '../../domain/lyrics'

export type SpringState = { value: number; velocity: number }

export type LyricVisual = {
  distance: number
  blurPx: number
  opacity: number
}

export type InterludeState = {
  /** Insert the breathing dots immediately before this line index. */
  beforeIndex: number
  /** Normalized progress across the interlude [0, 1]. */
  progress: number
  /** Per-dot fill level [0, 1] for Apple Music's 3 sequential dots. */
  dots: [number, number, number]
  /** True during the final ~320ms so dots gracefully shrink before vocals enter. */
  exiting: boolean
}

/** Sample a critically damped spring independently of the display's frame rate. */
export function stepSpring(state: SpringState, target: number, dtSec: number, speed = 15): SpringState {
  if (dtSec <= 0) return state
  const displacement = state.value - target
  const drift = state.velocity + speed * displacement
  const decay = Math.exp(-speed * dtSec)
  const value = target + (displacement + drift * dtSec) * decay
  const velocity = (state.velocity - speed * drift * dtSec) * decay
  if (Math.abs(target - value) < 0.15 && Math.abs(velocity) < 0.8) return { value: target, velocity: 0 }
  return { value, velocity }
}

/**
 * Golden vertical anchor ratio for the active lyric line inside the scroll viewport.
 * Wide desktop/tablet places the active line around 34% from top (matching Apple Music macOS/iPadOS)
 * so upcoming lines have generous breathing room while staying optically balanced with the cover art.
 */
export function lyricAnchorRatio(compact: boolean): number {
  return compact ? 0.42 : 0.34
}

export function lyricScrollTarget(
  lineTop: number,
  lineHeight: number,
  viewportHeight: number,
  anchorRatio: number,
): number {
  const anchorY = viewportHeight * anchorRatio
  return Math.max(0, lineTop + lineHeight / 2 - anchorY)
}

/** Short lines use a tighter cascade so the next handoff can start on time. */
export function staggerDelayMs(index: number, activeIndex: number, intervalMs: number): number {
  if (activeIndex < 0) return 0
  const perRow = index > activeIndex ? 28 : 20
  const cadence = Math.min(1, Math.max(0, intervalMs / 650))
  return Math.min(112, Math.abs(index - activeIndex) * perRow) * cadence
}

/**
 * Apple Music depth-of-field blur & opacity falloff by distance from the active line.
 * When the user hovers/browses or aligns timing (`clearFocus`), blur clears immediately.
 */
export function lyricLineVisual(index: number, activeIndex: number, clearFocus: boolean): LyricVisual {
  if (activeIndex < 0) return { distance: 0, blurPx: 0, opacity: 0.88 }
  const distance = index - activeIndex
  const abs = Math.abs(distance)
  if (abs === 0) return { distance: 0, blurPx: 0, opacity: 1 }
  if (clearFocus) {
    return { distance, blurPx: 0, opacity: abs === 1 ? 0.82 : 0.68 }
  }
  const blurTable = [0, 0.75, 1.65, 2.55, 3.45]
  const opacityTable = [1, 0.54, 0.37, 0.25, 0.17]
  const pastDamp = distance < 0 ? 0.86 : 1
  const idx = Math.min(abs, blurTable.length - 1)
  // Skip Gaussian blur far outside the visible viewport window to protect mobile/WebView GPU memory.
  const blurPx = abs <= 8 ? blurTable[idx] : 0
  return {
    distance,
    blurPx,
    opacity: Number((opacityTable[idx] * pastDamp).toFixed(3)),
  }
}

/**
 * Subtle vertical float (px, negative = upward) and soft glow intensity for word-by-word lyrics.
 */
export function wordMotion(progress01: number, durationMs: number): { liftPx: number; glow: number } {
  const p = Math.max(0, Math.min(1, progress01))
  if (p <= 0 || p >= 1) return { liftPx: 0, glow: 0 }
  // Smooth arch peaking around mid-word, with slightly stronger presence on sustained vocals.
  const arch = Math.sin(p * Math.PI)
  const sustain = durationMs >= 750 ? 1.25 : 1
  const liftPx = -Number((arch * 2.1 * sustain).toFixed(2))
  const glow = Number((arch * (durationMs >= 750 ? 1 : 0.72)).toFixed(3))
  return { liftPx, glow }
}

const INTRO_MIN_MS = 3000
const INTERLUDE_TIMED_MIN_MS = 4500
const INTERLUDE_UNTIMED_MIN_MS = 10000
const INTERLUDE_EXIT_MS = 320

/**
 * Detects intros and instrumental interludes to display Apple Music's 3 breathing dots.
 */
export function lyricInterludeState(lines: readonly LyricLine[], timeMs: number): InterludeState | null {
  if (!lines.length || !Number.isFinite(timeMs)) return null

  const first = lines[0]
  if (first.timeMs >= INTRO_MIN_MS && timeMs >= 0 && timeMs < first.timeMs) {
    const start = Math.min(400, first.timeMs * 0.12)
    if (timeMs < start) return null
    return buildInterlude(0, start, first.timeMs, timeMs)
  }

  for (let i = 0; i < lines.length - 1; i++) {
    const cur = lines[i]
    const next = lines[i + 1]
    if (timeMs < cur.timeMs || timeMs >= next.timeMs) continue

    const wordEnd = cur.words?.length ? cur.words[cur.words.length - 1].endTimeMs : undefined
    const explicitEnd = cur.endTimeMs ?? wordEnd
    if (explicitEnd !== undefined && explicitEnd <= next.timeMs) {
      const gap = next.timeMs - explicitEnd
      const start = explicitEnd + 350
      if (gap >= INTERLUDE_TIMED_MIN_MS && timeMs >= start && timeMs < next.timeMs) {
        return buildInterlude(i + 1, start, next.timeMs, timeMs)
      }
    } else {
      const gap = next.timeMs - cur.timeMs
      const estimatedEnd = cur.timeMs + Math.min(5000, Math.max(2600, cur.text.length * 240))
      if (gap >= INTERLUDE_UNTIMED_MIN_MS && timeMs >= estimatedEnd && timeMs < next.timeMs) {
        return buildInterlude(i + 1, estimatedEnd, next.timeMs, timeMs)
      }
    }
    return null
  }
  return null
}

function buildInterlude(beforeIndex: number, startMs: number, endMs: number, timeMs: number): InterludeState {
  const span = Math.max(1, endMs - startMs)
  const progress = Math.max(0, Math.min(1, (timeMs - startMs) / span))
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  const dots: [number, number, number] = [
    clamp(progress * 3),
    clamp(progress * 3 - 1),
    clamp(progress * 3 - 2),
  ]
  const exiting = endMs - timeMs <= INTERLUDE_EXIT_MS
  return { beforeIndex, progress, dots, exiting }
}

type ScrollPath = { from: SpringState; to: number; start: number; speed: number }

const samplePath = (path: ScrollPath, now: number) => stepSpring(path.from, path.to, (now - path.start) / 1000, path.speed)

type LineMotion = {
  index: number
  path: ScrollPath
  next?: ScrollPath
  offset: number
}

function currentPath(line: LineMotion, now: number) {
  if (line.next && now >= line.next.start) {
    line.path = line.next
    line.next = undefined
  }
  return line.path
}

/**
 * The scroller and staggered rows each follow a continuous position curve.
 * Row transforms only make up the difference against the native scroll position.
 */
export function createLyricSpringController() {
  let frame = 0
  let container: HTMLDivElement | null = null
  let scrollPath: ScrollPath | null = null
  let releaseTop = 0
  const rows = new Map<HTMLParagraphElement, LineMotion>()

  const stop = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    scrollPath = null
    container = null
    for (const element of rows.keys()) element.style.removeProperty('--lyric-wave-y')
    rows.clear()
  }

  const tick = (now: number) => {
    frame = 0
    if (!container) return
    let top = releaseTop
    if (scrollPath) {
      const scroll = samplePath(scrollPath, now)
      container.scrollTop = scroll.value
      top = container.scrollTop
      if (scroll.velocity !== 0 || scroll.value !== scrollPath.to) frame = requestAnimationFrame(tick)
    }
    for (const [element, row] of rows) {
      const path = currentPath(row, now)
      const position = samplePath(path, now)
      const offset = top - position.value
      if (row.next || position.velocity !== 0 || (scrollPath && path.to !== scrollPath.to) || frame) {
        row.offset = offset
        element.style.setProperty('--lyric-wave-y', `${offset.toFixed(2)}px`)
      } else {
        element.style.removeProperty('--lyric-wave-y')
        rows.delete(element)
      }
    }
    if (!frame && rows.size) frame = requestAnimationFrame(tick)
    if (!frame) scrollPath = null
  }

  const animate = (
    scroll: HTMLDivElement,
    targetTop: number,
    lines: readonly (HTMLParagraphElement | null)[],
    activeIndex: number,
    previousIndex: number,
    instant: boolean,
    intervalMs = Infinity,
  ) => {
    const target = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, targetTop))
    if (instant || (previousIndex >= 0 && Math.abs(activeIndex - previousIndex) > 4)) {
      stop()
      scroll.scrollTop = target
      return
    }
    if (container !== scroll) stop()
    container = scroll
    const oldScroll = scrollPath
    if (oldScroll?.to === target) return
    const now = performance.now()
    const from = oldScroll ? samplePath(oldScroll, now) : { value: scroll.scrollTop, velocity: 0 }
    if (!oldScroll && !rows.size && Math.abs(from.value - target) < 1) return
    const speed = 15 + 10 * (1 - Math.min(1, Math.max(0, (intervalMs - 200) / 600)))
    const nextPath = { from, to: target, start: now, speed }
    const previousPath = oldScroll ?? { ...nextPath, to: from.value }

    const consecutive = previousIndex >= 0 && activeIndex === previousIndex + 1 && Math.abs(target - from.value) < scroll.clientHeight * 0.85
    if (consecutive) {
      // Keep the cascade near the visible lyric rows.
      for (let index = Math.max(0, activeIndex - 8); index <= Math.min(lines.length - 1, activeIndex + 10); index++) {
        const element = lines[index]
        if (element && !rows.has(element) && index !== activeIndex) rows.set(element, { index, path: previousPath, offset: 0 })
      }
    }
    for (const [element, row] of rows) {
      const path = currentPath(row, now)
      const { index } = row
      if (lines[index] !== element || index < activeIndex - 8 || index > activeIndex + 10) {
        element.style.removeProperty('--lyric-wave-y')
        rows.delete(element)
        continue
      }
      // An already delayed row keeps its earlier deadline across rapid consecutive lyrics.
      const start = consecutive ? Math.min(row.next?.start ?? Infinity, now + staggerDelayMs(index, activeIndex, intervalMs)) : now
      row.next = { ...nextPath, from: samplePath(path, start), start }
    }
    scrollPath = nextPath
    if (!frame) frame = requestAnimationFrame(tick)
  }

  const releaseForUserScroll = () => {
    if (!container || !scrollPath) return
    releaseTop = container.scrollTop
    const now = performance.now()
    scrollPath = null
    for (const row of rows.values()) {
      row.path = { from: { value: releaseTop - row.offset, velocity: 0 }, to: releaseTop, start: now, speed: 24 }
      row.next = undefined
    }
  }

  return { animate, releaseForUserScroll, stop }
}
