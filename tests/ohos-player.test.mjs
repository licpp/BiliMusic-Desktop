import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const output = await build({
  entryPoints: ['native/ohos-player/ohos/PlayerPlugin.ets'], loader: { '.ets': 'ts' }, bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'harmony-system', setup(b) {
    b.onResolve({ filter: /^(@kit\.|libbilimusic_lib)/ }, args => ({ path: args.path, namespace: 'harmony' }))
    b.onLoad({ filter: /.*/, namespace: 'harmony' }, args => ({ contents: args.path === 'libbilimusic_lib.so' ? 'export default globalThis.ohosTest.native' : `
      export const wantAgent = globalThis.ohosTest.wantAgent;
      export const hilog = { info() {}, error() {} };
      export const media = globalThis.ohosTest.media;
      export const avSession = globalThis.ohosTest.avSession;
      export const backgroundTaskManager = globalThis.ohosTest.background;
      export const asset = globalThis.ohosTest.asset;
      export const fileIo = { readTextSync: () => globalThis.ohosTest.scope };
      export const util = globalThis.ohosTest.util;
    ` }))
  } }],
})

function setup() {
  const events = [], samples = [], replies = [], background = [], secrets = new Map()
  let player
  class FakePlayer {
    constructor() { this.callbacks = {}; this.currentTime = 0; this.duration = 180_000; this.state = 'idle' }
    // AVPlayer's second registration replaces the previous callback, unlike a
    // Node EventEmitter. This reproduces the real pause/resume regression.
    on(event, callback) { this.callbacks[event] = [callback] }
    emit(state) { this.state = state; for (const cb of this.callbacks.stateChange ?? []) cb(state) }
    set url(value) { this.source = value; this.emit('initialized') }
    async prepare() { this.emit('prepared') }
    async play() { this.emit('playing') }
    async pause() { this.emit('paused') }
    async release() { this.emit('released') }
    seek(ms) { this.currentTime = ms }
    setSpeed(value) { this.speed = value }
    setVolume(value) { this.volume = value }
  }
  // Match Harmony TextEncoder.encodeInto's byte-array return type.
  class Encoder { encodeInto(value) { return new TextEncoder().encode(value) } }
  const tags = { ALIAS: 1, SECRET: 2, ACCESSIBILITY: 3, RETURN_TYPE: 4 }
  const key = q => new TextDecoder().decode(q.get(tags.ALIAS))
  const missing = () => Object.assign(new Error('missing'), { code: 24000002 })
  const h = globalThis.ohosTest = {
    scope: '123',
    native: { tauriOhosPluginResponse: (id, ok, payload) => replies.push({ id, ok, value: JSON.parse(payload) }), bilimusicOhosState: s => events.push(JSON.parse(s)), bilimusicOhosListening: s => samples.push(JSON.parse(s)) },
    media: { createAVPlayer: async () => (player = new FakePlayer()) },
    avSession: { PlaybackState: { PLAYBACK_STATE_PLAY: 1, PLAYBACK_STATE_PAUSE: 2 }, createAVSession: async () => ({ on() {}, async activate() {}, async setAVMetadata() {}, async setAVPlaybackState() {}, async destroy() {} }) },
    background: { BackgroundMode: { AUDIO_PLAYBACK: 2 }, async startBackgroundRunning() { background.push('start') }, async stopBackgroundRunning() { background.push('stop') } },
    asset: { Tag: tags, Accessibility: { DEVICE_FIRST_UNLOCKED: 1 }, ReturnType: { ALL: 1 }, ErrorCode: { NOT_FOUND: 24000002 },
      async update(q, attrs) { if (!secrets.has(key(q))) throw missing(); secrets.set(key(q), attrs.get(tags.SECRET)) },
      async add(q) { secrets.set(key(q), q.get(tags.SECRET)) }, async query(q) { if (!secrets.has(key(q))) throw missing(); return [new Map([[tags.SECRET, secrets.get(key(q))]])] }, async remove(q) { if (!secrets.delete(key(q))) throw missing() },
    },
  }
  const finalCode = output.outputFiles[0].text
  h.util = { generateRandomUUID: () => 'session', TextEncoder: Encoder, TextDecoder: { create: () => ({ decodeWithStream: b => new TextDecoder().decode(b) }) } }
  // wantAgent is a separate named export in AbilityKit.
  h.wantAgent = { OperationType: { START_ABILITY: 1 }, WantAgentFlags: { UPDATE_PRESENT_FLAG: 1 }, async getWantAgent() { return {} } }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', finalCode)(createRequire(import.meta.url), module, module.exports)
  const plugin = new module.exports.PlayerPlugin({ async startAbility() {} })
  let id = 0
  const command = async (name, args = {}) => {
    const current = ++id
    plugin.dispatch(JSON.stringify({ id: current, plugin: 'ohos-player', command: name, payload: JSON.stringify(args) }))
    await plugin.tasks
    return replies.find(r => r.id === current)
  }
  return { plugin, command, events, samples, background, secrets, get player() { return player } }
}

test('Harmony player prepares real native transport, preserves position/rate, and stops its background task on pause', async () => {
  const h = setup()
  try {
    assert.equal((await h.command('play', { id: 'song', url: 'http://127.0.0.1:1234/media', position: 12, rate: 1.5, volume: .4 })).ok, true)
    assert.equal(h.player.currentTime, 12_000)
    assert.equal(h.player.speed, 6)
    assert.equal(h.player.volume, .4)
    assert.equal((await h.command('snapshot')).value.status, 'playing')
    await h.command('control', { action: 'pause' })
    assert.equal((await h.command('snapshot')).value.status, 'paused')
    assert.equal(h.events.at(-1).status, 'paused')
    for (let i = 0; i < 2; i++) {
      await h.command('control', { action: 'resume' })
      assert.equal((await h.command('snapshot')).value.status, 'playing')
      assert.equal(h.events.at(-1).status, 'playing')
      await h.command('control', { action: 'pause' })
      assert.equal((await h.command('snapshot')).value.status, 'paused')
      assert.equal(h.events.at(-1).status, 'paused')
    }
    assert.deepEqual(h.background, ['start', 'stop', 'start', 'stop', 'start', 'stop'])
    assert.equal((await h.command('play', { id: 'song', url: 'https://evil.example/music' })).ok, false)
  } finally { await h.plugin.destroy() }
})

test('Harmony sync credentials use the asset store, including update and idempotent deletion', async () => {
  const h = setup()
  try {
    assert.equal((await h.command('secret', { key: 'sync-123-jianguoyun', value: 'test-secret' })).ok, true)
    assert.equal((await h.command('secret', { key: 'sync-123-jianguoyun' })).value.value, 'test-secret')
    await h.command('secret', { key: 'sync-123-jianguoyun', value: 'changed' })
    assert.equal((await h.command('secret', { key: 'sync-123-jianguoyun' })).value.value, 'changed')
    await h.command('secret', { key: 'sync-123-jianguoyun', remove: true })
    assert.equal((await h.command('secret', { key: 'sync-123-jianguoyun', remove: true })).ok, true)
    assert.equal(h.secrets.size, 0)
    assert.equal((await h.command('secret', { key: 'unrelated', value: 'no' })).ok, false)
  } finally { await h.plugin.destroy() }
})

test('listening samples count elapsed playback, exclude seeks and pauses, and retain the existing account scope', async () => {
  const h = setup(), originalNow = Date.now
  let now = 100_000; Date.now = () => now
  try {
    await h.command('observe_listening', { profilePath: '/sandbox/active-profile' })
    await h.command('play', { id: 'song', url: 'http://127.0.0.1:1234/media' })
    h.plugin.accountListening()
    for (let i = 0; i < 16; i++) { now += 1000; h.player.currentTime += 1000; h.plugin.accountListening() }
    assert.equal(h.samples.filter(s => s.seconds).reduce((sum, s) => sum + s.seconds, 0), 15)
    await h.command('control', { action: 'seek', value: 100 })
    await h.command('control', { action: 'pause' })
    const counted = h.samples.filter(s => s.seconds).reduce((sum, s) => sum + s.seconds, 0)
    assert.equal(counted, 16)
    now += 30_000; h.plugin.accountListening(true)
    assert.equal(h.samples.filter(s => s.seconds).reduce((sum, s) => sum + s.seconds, 0), counted)
    assert.ok(h.samples.every(s => s.scope === '123' && s.trackId === 'song'))
  } finally { await h.plugin.destroy(); Date.now = originalNow }
})
