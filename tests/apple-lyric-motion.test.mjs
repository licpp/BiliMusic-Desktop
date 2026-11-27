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
  createLyricSpringController,
  stepSpring,
  lyricAnchorRatio,
  lyricScrollTarget,
  staggerDelayMs,
  lyricLineVisual,
  wordMotion,
  lyricInterludeState,
} = await moduleAt('src/features/lyrics/appleLyricMotion.ts')

function lyricMotionFixture(t) {
  let now = 0
  let callback
  t.mock.method(performance, 'now', () => now)
  globalThis.requestAnimationFrame = schedule => { callback = schedule; return 1 }
  globalThis.cancelAnimationFrame = () => { callback = undefined }
  t.after(() => {
    delete globalThis.requestAnimationFrame
    delete globalThis.cancelAnimationFrame
  })
  const scroll = { clientHeight: 400, scrollHeight: 2200, scrollTop: 200 }
  const lines = Array.from({ length: 32 }, () => ({
    style: {
      value: 0,
      setProperty(_name, value) { this.value = parseFloat(value) },
      removeProperty() { this.value = 0 },
    },
  }))
  return {
    scroll, lines,
    motion: createLyricSpringController(),
    position: index => scroll.scrollTop - lines[index].style.value,
    advance(ms = 16) {
      now += ms
      const tick = callback
      callback = undefined
      tick?.(now)
    },
  }
}

test('stagger starts without moving upcoming lines backwards and keeps position through a fast handoff', t => {
  const { scroll, lines, motion, position, advance } = lyricMotionFixture(t)
  motion.animate(scroll, 272, lines, 7, 6, false, 260)
  advance()
  assert.ok(position(7) > 200)
  assert.ok(position(8) >= 199.99, 'an upcoming line must not jump away before entering')
  for (let i = 0; i < 5; i++) advance()
  const before = position(8)
  motion.animate(scroll, 344, lines, 8, 7, false, 260)
  advance()
  assert.ok(position(8) >= before, 'the newly active line keeps its upward momentum')
  assert.ok(position(8) - before < 15, 'retargeting should not teleport the line forward')
  for (let i = 0; i < 80; i++) advance()
  assert.equal(scroll.scrollTop, 344)
  assert.ok(lines.every(line => line.style.value === 0))
})

test('stepSpring has the same trajectory with different frame rates and settles after suspension', () => {
  const initial = { value: 0, velocity: 0 }
  const direct = stepSpring(initial, 240, 0.15)
  let stepped = initial
  for (let i = 0; i < 18; i++) stepped = stepSpring(stepped, 240, 1 / 120)
  assert.ok(Math.abs(stepped.value - direct.value) < 1e-9)
  assert.ok(Math.abs(stepped.velocity - direct.velocity) < 1e-9)
  assert.deepEqual(stepSpring(initial, 240, 10), { value: 240, velocity: 0 })
})

test('lyricAnchorRatio and lyricScrollTarget place active lines at Apple Music golden focal point', () => {
  assert.equal(lyricAnchorRatio(false), 0.34)
  assert.equal(lyricAnchorRatio(true), 0.42)
  // Viewport 1000px -> anchor at 340px; line top 500, height 60 -> center 530 -> scrollTop 190.
  assert.equal(lyricScrollTarget(500, 60, 1000, 0.34), 190)
  // Clamps to 0 near top of document.
  assert.equal(lyricScrollTarget(20, 40, 1000, 0.34), 0)
})

test('staggerDelayMs trails upcoming lines, caps distant rows and responds to shorter intervals', () => {
  assert.equal(staggerDelayMs(3, 3, 900), 0)
  assert.equal(staggerDelayMs(4, 3, 900), 28)
  assert.equal(staggerDelayMs(2, 3, 900), 20)
  assert.equal(staggerDelayMs(50, 3, 900), 112)
  assert.equal(staggerDelayMs(4, 3, 325), 14)
  assert.equal(staggerDelayMs(0, -1, 900), 0)
})

test('browsing takes over the native scroll and seeking drops any remaining stagger', t => {
  const { scroll, lines, motion, position, advance } = lyricMotionFixture(t)
  motion.animate(scroll, 272, lines, 7, 6, false, 1200)
  advance(60)
  assert.ok(position(10) < scroll.scrollTop)
  motion.releaseForUserScroll()
  scroll.scrollTop += 22
  const manualTop = scroll.scrollTop
  for (let i = 0; i < 80; i++) advance()
  assert.equal(scroll.scrollTop, manualTop)
  assert.ok(lines.every(line => line.style.value === 0))

  motion.animate(scroll, 344, lines, 8, 7, false, 1200)
  advance()
  motion.animate(scroll, 1080, lines, 18, 8, false)
  assert.equal(scroll.scrollTop, 1080)
  assert.ok(lines.every(line => line.style.value === 0))
  advance()
  assert.equal(scroll.scrollTop, 1080)
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
