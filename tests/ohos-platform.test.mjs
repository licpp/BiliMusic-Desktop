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
    await audio.playOHOSAudio({ id: 'song', title: '歌曲', artist: '歌手' }, 'http://127.0.0.1:1234/media', 4, .7, true, 'collection', 1.5)
    assert.deepEqual(calls.at(-1).args, { url: 'http://127.0.0.1:1234/media', id: 'song', title: '歌曲', artist: '歌手', coverUrl: undefined, position: 4, volume: .7, playing: true, collectionRef: 'collection', rate: 1.5 })
    await audio.controlOHOSAudio('pause')
    assert.equal(calls.at(-1).args.action, 'pause')
  } finally { clearMocks(); globalThis.window = originalWindow }
})
