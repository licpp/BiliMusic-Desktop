import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const output = await build({
  entryPoints: ['src/features/player/playerStore.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['zustand', 'zustand/middleware'],
  plugins: [{ name: 'ios-boundary', setup(b) {
    b.onResolve({ filter: /services\/desktopApi$/ }, () => ({ path: 'api', namespace: 'mock' }))
    b.onResolve({ filter: /services\/platform$/ }, () => ({ path: 'platform', namespace: 'mock' }))
    b.onResolve({ filter: /^\.\/(mobileAudio|iosAudio)$/ }, args => ({ path: args.path, namespace: 'mock' }))
    b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'api' ? `
      export const inDesktopShell = true;
      export const recordPlayedTrack = async t => t;
      export const getTrackPlaybackUrl = t => globalThis.iosTest.resolve(t);
    ` : path === 'platform' ? 'export const isAndroid = false; export const isMobile = true; export const isIOS = true' : path === './iosAudio' ? `
      export const syncIOSQueue = async (...args) => globalThis.iosTest.queues.push(args);
      export const playIOSAudio = async (...args) => globalThis.iosTest.plays.push(args);
      export const iosListenerAge = () => 0;
      export const restartIOSAudioObservation = async () => {};
    ` : `
      export const observeMobileAudio = cb => { globalThis.iosTest.event = state => { globalThis.iosTest.state = state; cb(state) }; return Promise.resolve() };
      export const snapshotMobileAudio = async () => globalThis.iosTest.state || ({});
      export const mobilePlaybackClock = () => 0;
      export const controlMobileAudio = async (...args) => globalThis.iosTest.controls.push(args);
      export const prepareMobileAudio = async t => globalThis.iosTest.controls.push(['prepare', t.id]);
      export const playMobileAudio = async (...args) => globalThis.iosTest.plays.push(args);
    ` }))
  } }],
})
function setup() {
  globalThis.window = { addEventListener() {}, dispatchEvent() {}, setInterval() { return 0 } }
  globalThis.document = { addEventListener() {} }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.Audio = class { constructor() { throw new Error('iOS must not create WebView audio') } }
  globalThis.iosTest = { controls: [], plays: [], queues: [], resolve: async t => `http://127.0.0.1:1234/token/${t.id}` }
  const m = { exports: {} }; new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), m, m.exports)
  return m.exports
}
const track = id => ({ id, title: `song ${id}`, artist: '歌手', durationSeconds: 120, source: { provider: 'bilibili', bvid: 'BV123', cid: Number(id), page: Number(id) } })

test('iOS sends its full queue, playback mode, audio, seek and volume to native playback', async () => {
  const { usePlayerStore: s } = setup()
  await s.getState().playFromList([track('1'), track('2')], '1')
  assert.equal(iosTest.plays.length, 1)
  assert.deepEqual(iosTest.queues.at(-1)[0].map(t => t.id), ['1','2'])
  iosTest.event({ id: '1', status: 'playing', position: 12, duration: 120, stopped: false })
  s.getState().seek(20); s.getState().setVolume(.3); await s.getState().toggle()
  assert.deepEqual(iosTest.controls.slice(-3), [['seek', 20], ['volume', .3], ['pause']])
  s.getState().cyclePlaybackMode(); await Promise.resolve()
  assert.equal(iosTest.queues.at(-1)[1], 'all')
})
test('iOS reconciles background native track changes without resolving or playing twice', async () => {
  const { usePlayerStore: s } = setup()
  await s.getState().playFromList([track('1'),track('2')], '1')
  iosTest.event({ id: '1', status: 'playing', position: 100, stopped: false })
  iosTest.event({ id: '2', track: track('2'), status: 'buffering', stopped: true })
  assert.equal(s.getState().current.id, '2')
  iosTest.event({ id: '2', track: track('2'), status: 'playing', position: 3, duration: 120, stopped: false })
  assert.equal(s.getState().status, 'playing')
  assert.equal(s.getState().progressSeconds, 3)
  assert.equal(iosTest.plays.length, 1)
})
test('iOS cancelling URL resolution prevents late native autoplay', async () => {
  const { usePlayerStore: s } = setup(); let resolve
  iosTest.resolve = () => new Promise(r => { resolve = r })
  const pending = s.getState().play(track('1'))
  while (!resolve) await Promise.resolve()
  await s.getState().toggle(); resolve('http://127.0.0.1:1234/token/late'); await pending
  assert.equal(iosTest.plays.length, 0)
  assert.equal(s.getState().status, 'paused')
})
test('iOS account reset cannot revive a background track from the previous account', async () => {
  const { usePlayerStore: s, resetPlayerForAccount } = setup()
  await s.getState().playFromList([track('1'),track('2')], '1')
  await resetPlayerForAccount()
  iosTest.event({ id: '2', track: track('2'), status: 'playing', position: 3, stopped: false })
  assert.equal(s.getState().current, null)
  assert.deepEqual(s.getState().queue, [])
  assert.equal(s.getState().status, 'paused')
})
