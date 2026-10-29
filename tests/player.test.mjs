import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const output = await build({
  entryPoints: ['src/features/player/playerStore.ts'], bundle: true, write: false,
  format: 'cjs', platform: 'node', external: ['zustand', 'zustand/middleware'],
  plugins: [{ name: 'desktop-boundary', setup(builder) {
    builder.onResolve({ filter: /services\/desktopApi$/ }, () => ({ path: 'desktop-api', namespace: 'test' }))
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
      export const inDesktopShell = true;
      export const recordPlayedTrack = track => globalThis.testApi.record(track);
      export const getTrackPlaybackUrl = track => globalThis.testApi.resolve(track);
    ` }))
  } }],
})

function setup(snapshot) {
  const listeners = {}
  const audio = []
  const storage = new Map(snapshot ? [['resonance-player-v1', JSON.stringify(snapshot)]] : [])
  globalThis.window = { addEventListener: (name, callback) => { listeners[name] = callback } }
  globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  globalThis.Audio = class {
    src = ''; currentTime = 0; volume = 1; duration = 120; callbacks = {}; plays = 0
    constructor() { audio.push(this) }
    addEventListener(name, callback) { this.callbacks[name] = callback }
    pause() { this.callbacks.pause?.() }
    load() {}
    removeAttribute() { this.src = '' }
    async play() { this.plays++; this.callbacks.playing?.() }
  }
  globalThis.testApi = { record: async track => track, resolve: async track => `local://${track.id}` }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  return { store: module.exports.usePlayerStore, audio, listeners, storage }
}
const track = id => ({ id, source: { provider: 'bilibili', bvid: 'BVTEST00001', cid: Number(id), page: 1 }, title: id, durationSeconds: 120, liked: false })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('rapid switching discards stale source responses', async () => {
  const { store, audio, listeners } = setup()
  const old = deferred()
  globalThis.testApi.resolve = async value => value.id === '1' ? old.promise : 'local://2'
  const first = store.getState().play(track('1'))
  await Promise.resolve()
  await store.getState().play(track('2'))
  old.resolve('local://1'); await first
  assert.equal(store.getState().current.id, '2')
  assert.equal(audio[0].src, 'local://2')
  assert.equal(audio[0].plays, 1)
  listeners.pagehide()
})

test('pause while resolving cancels pending autoplay and resumes correct track', async () => {
  const { store, audio, listeners } = setup()
  const pending = deferred()
  globalThis.testApi.resolve = () => pending.promise
  const playing = store.getState().play(track('1'))
  await Promise.resolve()
  await store.getState().toggle()
  pending.resolve('local://1'); await playing
  assert.equal(store.getState().status, 'paused')
  assert.equal(audio[0].plays, 0)
  globalThis.testApi.resolve = async () => 'local://1'
  await store.getState().toggle()
  assert.equal(audio[0].src, 'local://1')
  assert.equal(store.getState().status, 'playing')
  listeners.pagehide()
})

test('queue operations preserve stable identities and synchronize metadata', () => {
  const { store, listeners } = setup()
  store.getState().enqueue([track('1'), track('2'), track('1')])
  assert.deepEqual(store.getState().queue.map(t => t.id), ['1', '2'])
  store.getState().moveInQueue('2', -1)
  store.getState().updateTrack({ ...track('2'), artist: '歌手' })
  assert.equal(store.getState().queue[0].artist, '歌手')
  store.getState().removeFromQueue('1')
  assert.equal(store.getState().queue.length, 1)
  store.getState().clearQueue()
  assert.equal(store.getState().queue.length, 0)
  listeners.pagehide()
})

test('restart restores queue, position and volume without autoplay', async () => {
  const { store, audio, listeners } = setup({ state: { current: track('1'), queue: [track('1')], progressSeconds: 32, durationSeconds: 120, volume: .25, repeatMode: 'all', shuffled: false }, version: 0 })
  assert.equal(store.getState().status, 'paused')
  assert.equal(audio.length, 0)
  await store.getState().toggle()
  assert.equal(audio[0].currentTime, 32)
  assert.equal(audio[0].volume, .25)
  listeners.pagehide()
})

test('restored Bilibili covers use HTTPS allowed by the desktop CSP', () => {
  const input = { ...track('1'), coverUrl: 'http://i0.hdslb.com/cover.jpg' }
  const { store, listeners } = setup({ state: { current: input, queue: [input] }, version: 0 })
  assert.equal(store.getState().current.coverUrl, 'https://i0.hdslb.com/cover.jpg')
  assert.equal(store.getState().queue[0].coverUrl, 'https://i0.hdslb.com/cover.jpg')
  listeners.pagehide()
})

test('one playback mode control cycles mutually exclusive modes and persists them', async () => {
  const { store, listeners, storage } = setup()
  const modes = []
  for (let i=0;i<4;i++) {
    store.getState().cyclePlaybackMode()
    modes.push([store.getState().shuffled,store.getState().repeatMode])
  }
  assert.deepEqual(modes, [[false,'all'],[false,'one'],[true,'all'],[false,'off']])
  store.getState().cyclePlaybackMode(); store.getState().cyclePlaybackMode()
  store.setState({ queue:[track('1'),track('2')],current:track('1') })
  await store.getState().next(true)
  assert.equal(store.getState().current.id,'1','single repeat must replay the same song')
  store.getState().cyclePlaybackMode()
  await store.getState().next(true)
  assert.equal(store.getState().current.id,'2','random mode must not retain single-repeat behavior')
  listeners.pagehide()
  const restored=setup(JSON.parse(storage.get('resonance-player-v1')))
  assert.equal(restored.store.getState().shuffled,true)
  assert.equal(restored.store.getState().repeatMode,'all')
  restored.listeners.pagehide()
})
