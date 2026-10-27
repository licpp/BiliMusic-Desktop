import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const output = await build({
  entryPoints: ['src/features/player/playerStore.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['zustand', 'zustand/middleware'],
  plugins: [{ name: 'android-boundary', setup(b) {
    b.onResolve({ filter: /services\/desktopApi$/ }, () => ({ path: 'api', namespace: 'mock' }))
    b.onResolve({ filter: /services\/platform$/ }, () => ({ path: 'platform', namespace: 'mock' }))
    b.onResolve({ filter: /\.\/androidAudio$/ }, () => ({ path: 'audio', namespace: 'mock' }))
    b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'api' ? `
      export const inDesktopShell = true;
      export const recordPlayedTrack = async t => t;
      export const getTrackPlaybackUrl = t => globalThis.nativeTest.resolve(t);
    ` : path === 'platform' ? 'export const isAndroid = true' : `
      export const observeAndroidAudio = cb => { globalThis.nativeTest.event = state => { globalThis.nativeTest.state = state; cb(state) }; return Promise.resolve() };
      export const snapshotAndroidAudio = async () => globalThis.nativeTest.state || ({});
      export const androidPlaybackClock = () => 0;
      export const controlAndroidAudio = async (...args) => globalThis.nativeTest.controls.push(args);
      export const prepareAndroidAudio = async t => globalThis.nativeTest.controls.push(['prepare', t.id]);
      export const playAndroidAudio = async (...args) => globalThis.nativeTest.plays.push(args);
    ` }))
  } }],
})
function setup() {
  globalThis.window = { addEventListener() {} }
  globalThis.document = { addEventListener() {} }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.Audio = class { constructor() { throw new Error('Android must not create WebView audio') } }
  globalThis.nativeTest = { controls: [], plays: [], resolve: async t => `http://127.0.0.1:1234/token/${t.id}` }
  const m = { exports: {} }; new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), m, m.exports)
  return m.exports.usePlayerStore
}
const track = { id: 'bilibili:BV123:1', title: '歌曲', artist: '歌手', durationSeconds: 120, source: { bvid: 'BV123', cid: 1, page: 1 } }
test('Android routes playback, seek and volume to native service and accepts only current track state', async () => {
  const s = setup(); await s.getState().play(track)
  assert.equal(nativeTest.plays.length, 1)
  assert.deepEqual(nativeTest.controls[0], ['prepare', track.id])
  nativeTest.event({ id: track.id, status: 'playing', position: 12, duration: 120 })
  assert.equal(s.getState().status, 'playing')
  nativeTest.event({ id: 'old', status: 'error', error: 'stale' })
  assert.equal(s.getState().status, 'playing')
  nativeTest.state = { id: track.id, status: 'playing' }
  s.getState().seek(20); s.getState().setVolume(.3); await s.getState().toggle()
  assert.deepEqual(nativeTest.controls.slice(-3), [['seek', 20], ['volume', .3], ['pause']])
})
test('Android cancel during URL resolution prevents late native autoplay', async () => {
  const s = setup(); let resolve
  nativeTest.resolve = () => new Promise(r => { resolve = r })
  const playing = s.getState().play(track)
  while (!resolve) await Promise.resolve()
  nativeTest.event({ id: track.id, status: 'buffering', stopped: true })
  assert.equal(s.getState().status, 'resolving')
  await s.getState().toggle(); resolve('http://127.0.0.1:1234/token/late'); await playing
  assert.equal(nativeTest.plays.length, 0)
  assert.equal(s.getState().status, 'paused')
})
test('Android URL failure stops the preparing foreground service', async () => {
  const s = setup(); nativeTest.resolve = async () => { throw new Error('source unavailable') }
  await s.getState().play(track)
  assert.deepEqual(nativeTest.controls.at(-1), ['stop'])
  assert.equal(s.getState().status, 'error')
})
