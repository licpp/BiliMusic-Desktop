import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

async function moduleAt(path) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const {
  stepSpring,
  lyricAnchorRatio,
  lyricScrollTarget,
  staggerDelayMs,
  lyricLineVisual,
  wordMotion,
  lyricInterludeState,
} = await moduleAt('src/features/lyrics/appleLyricMotion.ts')

test('stepSpring converges smoothly to target without exploding on large frame drops', () => {
  let state = { value: 0, velocity: 0 }
  for (let i = 0; i < 180; i++) {
    state = stepSpring(state, 240, 1 / 60)
  }
  assert.equal(state.value, 240)
  assert.equal(state.velocity, 0)

  // Clamped dt protects stability after background tab suspension.
  const afterSpike = stepSpring({ value: 0, velocity: 0 }, 200, 10)
  assert.ok(Number.isFinite(afterSpike.value) && afterSpike.value > 0 && afterSpike.value < 200)
})

test('lyricAnchorRatio and lyricScrollTarget place active lines at Apple Music golden focal point', () => {
  assert.equal(lyricAnchorRatio(false), 0.34)
  assert.equal(lyricAnchorRatio(true), 0.42)
  // Viewport 1000px -> anchor at 340px; line top 500, height 60 -> center 530 -> scrollTop 190.
  assert.equal(lyricScrollTarget(500, 60, 1000, 0.34), 190)
  // Clamps to 0 near top of document.
  assert.equal(lyricScrollTarget(20, 40, 1000, 0.34), 0)
})

test('staggerDelayMs increases with distance, favors upcoming trail, and caps cleanly', () => {
  assert.equal(staggerDelayMs(3, 3), 0)
  assert.equal(staggerDelayMs(4, 3), 38)
  assert.equal(staggerDelayMs(2, 3), 26)
  assert.equal(staggerDelayMs(50, 3), 260)
  assert.equal(staggerDelayMs(0, -1), 0)
})

test('lyricLineVisual computes distance depth-of-field blur/opacity and clears blur on focus', () => {
  const active = lyricLineVisual(5, 5, false)
  assert.deepEqual(active, { distance: 0, blurPx: 0, opacity: 1 })

  const next1 = lyricLineVisual(6, 5, false)
  const next3 = lyricLineVisual(8, 5, false)
  assert.ok(next1.blurPx > 0 && next3.blurPx > next1.blurPx)
  assert.ok(next1.opacity < 1 && next3.opacity < next1.opacity)

  const prev1 = lyricLineVisual(4, 5, false)
  assert.ok(prev1.opacity < next1.opacity, 'past lines dim slightly more than upcoming lines')

  const cleared = lyricLineVisual(8, 5, true)
  assert.equal(cleared.blurPx, 0)
  assert.ok(cleared.opacity > next3.opacity)

  // Far off-screen lines skip Gaussian blur to protect mobile/WebView GPU memory while retaining dim opacity.
  const far = lyricLineVisual(20, 5, false)
  assert.equal(far.blurPx, 0)
  assert.equal(far.opacity, 0.17)
})

test('wordMotion arches gently upward mid-word and settles to 0 at boundaries', () => {
  assert.deepEqual(wordMotion(0, 400), { liftPx: 0, glow: 0 })
  assert.deepEqual(wordMotion(1, 400), { liftPx: 0, glow: 0 })

  const shortMid = wordMotion(0.5, 350)
  const longMid = wordMotion(0.5, 1100)
  assert.ok(shortMid.liftPx < 0 && shortMid.glow > 0)
  assert.ok(longMid.liftPx < shortMid.liftPx, 'sustained vocals lift slightly higher')
  assert.ok(longMid.glow > shortMid.glow, 'sustained vocals glow slightly warmer')
})

test('lyricInterludeState detects long intros, timed interludes, untimed gaps, and exit window', () => {
  const timedLines = [
    { timeMs: 6000, endTimeMs: 9000, text: 'First line' },
    { timeMs: 16000, endTimeMs: 19000, text: 'After interlude' },
    { timeMs: 20500, endTimeMs: 23000, text: 'Immediate next line' },
  ]

  // Before intro grace start -> null
  assert.equal(lyricInterludeState(timedLines, 100), null)

  // Mid-intro -> dots before line 0
  const intro = lyricInterludeState(timedLines, 3200)
  assert.ok(intro)
  assert.equal(intro.beforeIndex, 0)
  assert.equal(intro.exiting, false)
  assert.ok(intro.dots[0] > 0 && intro.dots[0] <= 1)

  // Right before vocals enter -> exiting flag turns true
  const introExit = lyricInterludeState(timedLines, 5850)
  assert.ok(introExit?.exiting)

  // During active line 0 -> null
  assert.equal(lyricInterludeState(timedLines, 7500), null)

  // During 7s timed instrumental gap -> dots before line 1
  const midGap = lyricInterludeState(timedLines, 12500)
  assert.ok(midGap)
  assert.equal(midGap.beforeIndex, 1)
  assert.ok(midGap.dots[0] === 1 && midGap.dots[1] > 0)

  // Short 1.5s gap between line 1 & 2 -> no interlude dots
  assert.equal(lyricInterludeState(timedLines, 19800), null)

  // Untimed lyrics with >=10s gap
  const untimed = [
    { timeMs: 1000, text: 'Hello' },
    { timeMs: 15000, text: 'Later' },
  ]
  assert.equal(lyricInterludeState(untimed, 2000), null)
  const untimedGap = lyricInterludeState(untimed, 9500)
  assert.ok(untimedGap)
  assert.equal(untimedGap.beforeIndex, 1)
})

test('shared lyric styles preserve Chromium WebView 66 car fallbacks and responsive tablet landscape alignment', () => {
  const css = readFileSync(new URL('../src/styles/components/lyrics.css', import.meta.url), 'utf8')
  // WebView 66 fallback without color-mix must precede the @supports enhancement.
  const fallbackIdx = css.indexOf('background-image:linear-gradient(to right,var(--lyric-active) var(--word-progress,0%),var(--lyric-unsung) var(--word-progress,0%))')
  const enhancedIdx = css.indexOf('@supports (color: color-mix(in srgb, #fff, #000))')
  assert.ok(fallbackIdx > 0 && enhancedIdx > fallbackIdx, 'plain linear-gradient fallback must appear before @supports color-mix')
  // Car / large-screen layout must not promote every lyric word into a composited inline-block layer.
  assert.match(css, /:root:not\(\[data-layout="large"\]\)\s+\.lyric-word\s*\{[^}]*display:inline-block/)
  // Tablet landscape aligns left like iPadOS Apple Music; phone/portrait stays centered.
  assert.match(css, /@media\(min-width:961px\)\s*\{[^}]*:root\[data-layout="mobile"\]\s+\.lyrics-scroll\s+p\s*\{[^}]*text-align:left/)
  assert.match(css, /@media\(max-width:960px\)\s*\{[^}]*:root\[data-layout="mobile"\]\s+\.lyrics-scroll\s+p\s*\{[^}]*text-align:center/)
})
