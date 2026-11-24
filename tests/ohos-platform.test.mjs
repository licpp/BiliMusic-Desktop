import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'

const require = createRequire(import.meta.url)
function evaluate(output) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports)
  return module.exports
}

test('OHOS build marker takes precedence over Android UA; ordinary four-platform builds keep their detection', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalTauri = globalThis.isTauri
  try {
    for (const [marker, ua, touches, shell, expected] of [
      ['ohos', 'Mozilla Android HarmonyOS', 5, true, 'ohos'],
      ['ohos', 'Linux; OpenHarmony', 5, true, 'ohos'],
      ['', 'Android', 5, true, 'android'],
      ['', 'iPhone', 5, true, 'ios'],
      ['', 'Macintosh', 5, true, 'ios'],
      ['', 'Macintosh', 0, true, 'desktop'],
      ['', 'Windows NT', 0, true, 'desktop'],
      ['ohos', 'Android', 5, false, 'desktop'],
    ]) {
      globalThis.isTauri = shell
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: ua, maxTouchPoints: touches } })
      const output = await build({ entryPoints: ['src/services/platform.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', define: { 'import.meta.env': JSON.stringify({ VITE_BILIMUSIC_PLATFORM: marker }) } })
      const p = evaluate(output)
      assert.equal(p.isOHOS ? 'ohos' : p.isAndroid ? 'android' : p.isIOS ? 'ios' : 'desktop', expected)
      assert.equal(p.isMobile, expected !== 'desktop')
    }
  } finally {
    globalThis.isTauri = originalTauri
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete globalThis.navigator
  }
})

test('OHOS reuses native audio transport with real Tauri Channel delivery and playback arguments', async () => {
  const originalWindow = globalThis.window
  globalThis.window = { crypto: webcrypto }
  const calls = []
  let channel
  mockIPC((command, args) => {
    assert.ok(command.startsWith('plugin:ohos-player|'), command)
    calls.push({ command, args })
    if (command.endsWith('|observe')) channel = args.handler
    if (command.endsWith('|snapshot')) return { id: 'song', status: 'paused', position: 4, duration: 120 }
  })
  try {
    const audio = evaluate(await build({ entryPoints: ['src/features/player/ohosAudio.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' }))
    const states = []
    await audio.observeOHOSAudio(s => states.push(s))
    assert.equal(states[0].position, 4)
    window.__TAURI_INTERNALS__.runCallback(channel.id, { index: 0, message: { id: 'song', status: 'playing', position: 10, rate: 1.5 } })
    assert.equal(states.at(-1).position, 10)
    assert.ok(audio.ohosPlaybackClock() >= 10)
    await audio.playOHOSAudio({ id: 'song', title: '歌曲', artist: '歌手', album: '专辑', durationSeconds: 120 }, 'http://127.0.0.1:1234/media', 4, .7, true, 'collection', 1.5)
    assert.deepEqual(calls.at(-1).args, { loudnessEnabled: false, loudnessRevision: 0, loudnessGainDb: 0, url: 'http://127.0.0.1:1234/media', id: 'song', title: '歌曲', artist: '歌手', album: '专辑', coverUrl: undefined, durationSeconds: 120, position: 4, volume: .7, playing: true, collectionRef: 'collection', rate: 1.5 })
    await audio.controlOHOSAudio('pause')
    assert.equal(calls.at(-1).args.action, 'pause')
  } finally { clearMocks(); globalThis.window = originalWindow }
})

test('HarmonyOS uses the default network for playback and rechecks when returning to the app', async () => {
  const originals = Object.fromEntries(['window', 'document', 'navigator', 'isTauri'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const appWindow = Object.assign(new EventTarget(), { crypto: webcrypto })
  const appDocument = Object.assign(new EventTarget(), { hidden: false })
  let online = true
  let requests = 0
  let cacheReads = 0
  const cached = { id: 'cached', source: { bvid: 'BVCached', cid: 1, page: 1 } }
  const streaming = { id: 'streaming', source: { bvid: 'BVStreaming', cid: 2, page: 1 } }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  try {
    for (const [key, value] of Object.entries({
      window: appWindow, document: appDocument, isTauri: true,
      navigator: { userAgent: 'HarmonyOS Android', maxTouchPoints: 5, onLine: false },
    })) Object.defineProperty(globalThis, key, { configurable: true, value })
    mockIPC((command, args) => {
      assert.equal(command, 'plugin:ohos-player|control')
      assert.deepEqual(args, { action: 'networkOnline' })
      requests++
      return online
    })
    const { offlineUnavailable, startOfflinePlayback, useOfflinePlayback } = evaluate(await build({
      entryPoints: ['src/features/player/offlinePlayback.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
      define: { 'import.meta.env': JSON.stringify({ VITE_BILIMUSIC_PLATFORM: 'ohos' }) },
    }))
    startOfflinePlayback(async () => { cacheReads++; return [cached] })
    await settle()
    assert.equal(requests, 1)
    assert.equal(cacheReads, 0)
    assert.equal(offlineUnavailable(streaming), false)

    online = false
    appWindow.dispatchEvent(new Event('offline'))
    await settle()
    assert.equal(useOfflinePlayback.getState().offline, true)
    assert.equal(cacheReads, 1)
    assert.equal(offlineUnavailable(streaming), true)
    assert.equal(offlineUnavailable(cached), false)

    online = true
    appDocument.dispatchEvent(new Event('visibilitychange'))
    await settle()
    assert.equal(useOfflinePlayback.getState().offline, false)
    assert.equal(offlineUnavailable(streaming), false)
    assert.equal(cacheReads, 1)
  } finally {
    clearMocks()
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
