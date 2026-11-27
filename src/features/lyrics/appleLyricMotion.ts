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

const MAX_DT_SEC = 1 / 24

/**
 * Semi-implicit Euler damped harmonic oscillator.
 * Produces Apple Music / AMLL-style organic momentum without layout thrashing.
 */
export function stepSpring(
  state: SpringState,
  target: number,
  dtSec: number,
  stiffness = 135,
  damping = 22.5,
): SpringState {
  const dt = Math.max(0, Math.min(MAX_DT_SEC, dtSec))
  if (dt === 0) return state
  const displacement = state.value - target
  const acceleration = -stiffness * displacement - damping * state.velocity
  const velocity = state.velocity + acceleration * dt
  const value = state.value + velocity * dt
  if (Math.abs(target - value) < 0.15 && Math.abs(velocity) < 0.8) {
    return { value: target, velocity: 0 }
  }
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

/**
 * Staggered cascade delay (ms) by signed distance from the active line,
 * inspired by AMLL's elastic per-line arrival wave.
 */
export function staggerDelayMs(index: number, activeIndex: number): number {
  if (activeIndex < 0) return 0
  const dist = Math.abs(index - activeIndex)
  if (dist === 0) return 0
  // Upcoming lines trail slightly further behind active than past lines exiting upward.
  const perRow = index > activeIndex ? 38 : 26
  return Math.min(260, dist * perRow)
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

type LineWave = {
  element: HTMLElement
  delayMs: number
  state: SpringState
}

/**
 * Imperative rAF spring controller driving both smooth elastic scrollTop and
 * staggered per-line vertical cascade waves (`--lyric-wave-y`) without touching React state.
 */
export function createLyricSpringController() {
  let frame = 0
  let lastTime = 0
  let scrollSpring: SpringState | null = null
  let scrollTarget = 0
  let scrollEl: HTMLDivElement | null = null
  let waves: LineWave[] = []

  const clearWaves = () => {
    for (const wave of waves) {
      wave.element.style.removeProperty('--lyric-wave-y')
    }
    waves = []
  }

  const stop = (resetWaves = false) => {
    if (frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    scrollSpring = null
    if (resetWaves) clearWaves()
  }

  const animate = (
    container: HTMLDivElement,
    targetTop: number,
    lines: (HTMLParagraphElement | null)[],
    activeIndex: number,
    previousIndex: number,
    instant: boolean,
  ) => {
    scrollEl = container
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
    const clampedTarget = Math.max(0, Math.min(maxScroll, targetTop))

    if (instant) {
      stop(true)
      container.scrollTop = clampedTarget
      return
    }

    const currentTop = scrollSpring ? scrollSpring.value : container.scrollTop
    const deltaY = clampedTarget - currentTop
    scrollTarget = clampedTarget
    scrollSpring = { value: currentTop, velocity: scrollSpring?.velocity ?? 0 }

    // Seed per-line staggered elastic cascade waves when advancing smoothly between nearby lines.
    if (
      activeIndex >= 0 &&
      previousIndex >= 0 &&
      activeIndex !== previousIndex &&
      Math.abs(activeIndex - previousIndex) <= 4 &&
      Math.abs(deltaY) > 2 &&
      Math.abs(deltaY) < container.clientHeight * 0.85
    ) {
      const nextWaves: LineWave[] = []
      const existing = new Map(waves.map(w => [w.element, w.state]))
      // Limit wave physics strictly to lines near the viewport for constant-time 120fps performance.
      const start = Math.max(0, activeIndex - 8)
      const end = Math.min(lines.length - 1, activeIndex + 10)
      for (let i = start; i <= end; i++) {
        const el = lines[i]
        if (!el) continue
        const prev = existing.get(el)
        const delayMs = staggerDelayMs(i, activeIndex)
        if (delayMs === 0 && !prev) continue
        // Positive wave offset trails the scroll slightly, then springs cleanly into place.
        const seedOffset = Math.max(-44, Math.min(44, deltaY * 0.42))
        nextWaves.push({
          element: el,
          delayMs,
          state: prev
            ? { value: prev.value + seedOffset * 0.55, velocity: prev.velocity }
            : { value: seedOffset, velocity: 0 },
        })
      }
      // Clear any lines that fell out of the visible window.
      for (const old of waves) {
        if (!nextWaves.some(n => n.element === old.element)) {
          old.element.style.removeProperty('--lyric-wave-y')
        }
      }
      waves = nextWaves
    }

    if (frame) return
    lastTime = performance.now()
    const tick = (now: number) => {
      const dtMs = Math.max(1, Math.min(42, now - lastTime))
      lastTime = now
      const dtSec = dtMs / 1000
      let busy = false

      if (scrollEl && scrollSpring) {
        scrollSpring = stepSpring(scrollSpring, scrollTarget, dtSec, 130, 22)
        scrollEl.scrollTop = scrollSpring.value
        if (scrollSpring.value !== scrollTarget || scrollSpring.velocity !== 0) {
          busy = true
        } else {
          scrollSpring = null
        }
      }

      const remaining: LineWave[] = []
      for (const wave of waves) {
        if (wave.delayMs > 0) {
          wave.delayMs = Math.max(0, wave.delayMs - dtMs)
          wave.element.style.setProperty('--lyric-wave-y', `${wave.state.value.toFixed(2)}px`)
          remaining.push(wave)
          busy = true
          continue
        }
        wave.state = stepSpring(wave.state, 0, dtSec, 175, 21)
        if (wave.state.value === 0 && wave.state.velocity === 0) {
          wave.element.style.removeProperty('--lyric-wave-y')
        } else {
          wave.element.style.setProperty('--lyric-wave-y', `${wave.state.value.toFixed(2)}px`)
          remaining.push(wave)
          busy = true
        }
      }
      waves = remaining

      if (busy) {
        frame = requestAnimationFrame(tick)
      } else {
        frame = 0
      }
    }
    frame = requestAnimationFrame(tick)
  }

  /** Smoothly release waves when the user starts manual trackpad/wheel browsing. */
  const releaseForUserScroll = () => {
    scrollSpring = null
    for (const wave of waves) {
      wave.delayMs = 0
    }
    if (!waves.length && frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
  }

  return { animate, releaseForUserScroll, stop }
}
