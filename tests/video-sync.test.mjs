import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const output = await build({ entryPoints: ['src/features/lyrics/videoSync.ts'], bundle: true, write: false, format: 'esm' })
const { synchronizeVideo } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
function video(overrides = {}) { return { readyState: 4, seeking: false, currentTime: 10, playbackRate: 1, paused: true, buffered: { length: 0 }, plays: 0, pause() { this.paused = true }, async play() { this.paused = false; this.plays++ }, ...overrides } }

test('initial sync seeks once after metadata is available', () => {
  const element = video({ readyState: 1 })
  synchronizeVideo(element, 90, true, 90, true)
  assert.equal(element.currentTime, 90)
  element.seeking = true
  synchronizeVideo(element, 90.5, true, 90)
  assert.equal(element.currentTime, 90)
})
test('buffering does not trigger repeated seeks or play requests', () => {
  const element = video({ readyState: 1 })
  synchronizeVideo(element, 15, true, 15)
  synchronizeVideo(element, 15.25, true, 15)
  assert.equal(element.currentTime, 10)
  assert.equal(element.plays, 0)
})
test('already aligned first frame does not trigger another startup seek', () => {
  let seeks = 0
  const element = video({ currentTime: 0 })
  Object.defineProperty(element, 'currentTime', { get: () => 0, set: () => { seeks++ } })
  synchronizeVideo(element, .1, true, .1, true)
  assert.equal(seeks, 0)
  assert.equal(element.plays, 1)
})
test('small drift adjusts playback speed without discarding buffered frames', () => {
  const element = video()
  synchronizeVideo(element, 10.5, true, 10.25)
  assert.equal(element.currentTime, 10)
  assert.equal(element.playbackRate, 1.06)
  assert.equal(element.plays, 1)
})
test('audio timeline jumps seek video and pause follows the audio master', () => {
  const element = video({ paused: false })
  synchronizeVideo(element, 80, true, 10)
  assert.equal(element.currentTime, 80)
  synchronizeVideo(element, 80, false, 80)
  assert.equal(element.paused, true)
  assert.equal(element.playbackRate, 1)
})

test('a slow initial seek can finish without starting another CDN request', () => {
  const element = video({ readyState: 1 })
  synchronizeVideo(element, 90, true, 90, true)
  element.readyState = 2
  synchronizeVideo(element, 93, true, 90, false, 3)
  assert.equal(element.currentTime, 90)
  assert.equal(element.plays, 1)
  assert.ok(element.playbackRate > 1)
  element.buffered = { length: 1, start: () => 90, end: () => 96 }
  synchronizeVideo(element, 93.2, true, 93, false, .2)
  assert.equal(element.currentTime, 93.2)
})

test('an explicit seek during buffering is applied once the in-flight seek finishes', () => {
  const element = video({ seeking: true })
  const pending = synchronizeVideo(element, 80, true, 10, false, .25)
  assert.equal(pending, true)
  assert.equal(element.currentTime, 10)
  element.seeking = false
  assert.equal(synchronizeVideo(element, 80.2, true, 80, pending, .2), false)
  assert.equal(element.currentTime, 80.2)
})

test('video follows audio at 2× without treating expected progress as a seek', () => {
  const element = video({ currentTime: 12 })
  synchronizeVideo(element, 12, true, 10, false, 1, 2)
  assert.equal(element.playbackRate, 2)
  assert.equal(element.currentTime, 12)
  synchronizeVideo(element, 20, true, 12, false, .25, 2)
  assert.equal(element.currentTime, 20)
})
