import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { build } from 'esbuild'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'

const root = 'native/android-player/'
const [manifest, defaults, kotlin] = await Promise.all([
  readFile(root + 'build.rs', 'utf8'), readFile(root + 'permissions/default.toml', 'utf8'),
  readFile(root + 'android/src/main/java/PlayerPlugin.kt', 'utf8'),
])
const strings = text => [...text.matchAll(/"([^"]+)"/g)].map(match => match[1])
const commands = new Set(strings(manifest.match(/Builder::new\(&\[([\s\S]*?)\]/)[1]))
const permissions = new Set(strings(defaults.match(/permissions\s*=\s*\[([\s\S]*?)\]/)[1]))
const methods = new Set([...kotlin.matchAll(/@Command\s+fun\s+(\w+)\(/g)].map(match => match[1]))
const capability = JSON.parse(await readFile('src-tauri/capabilities/android.json', 'utf8'))
const output = await build({ entryPoints: ['src/features/player/androidAudio.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' })

test('real Tauri SDK listener registration, events, playback and removal satisfy native command ACL', async () => {
  assert.ok(capability.platforms.includes('android'))
  assert.ok(capability.permissions.includes('android-player:default'))
  globalThis.window = { crypto: webcrypto }
  const calls = []; let handler
  mockIPC((full, payload) => {
    const command = full.split('|')[1]
    assert.ok(commands.has(command), `${command}: absent from generated command manifest`)
    assert.ok(permissions.has(`allow-${command.replaceAll('_', '-')}`), `${command}: not granted by default`)
    assert.ok(methods.has(command), `${command}: no exported Kotlin implementation`)
    calls.push(command)
    if (command === 'register_listener') handler = payload.handler
    if (command === 'snapshot') return { id: 'test', status: 'playing', position: 5 }
  })
  try {
    const module = { exports: {} }
    new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
    const audio = module.exports; const states = []
    const subscription = await audio.observeAndroidAudio(state => states.push(state))
    window.__TAURI_INTERNALS__.runCallback(handler.id, { index: 0, message: { id: 'test', position: 5, status: 'playing', duration: 120 } })
    assert.equal(states[0].position, 5)
    const track = { id: 'test', title: 'song', artist: 'artist' }
    await audio.prepareAndroidAudio(track)
    await audio.playAndroidAudio(track, 'http://127.0.0.1:1234/token/media', 5, .7)
    assert.equal((await audio.snapshotAndroidAudio()).status, 'playing')
    await subscription.unregister()
    assert.deepEqual(calls, ['register_listener', 'control', 'play', 'snapshot', 'remove_listener'])
  } finally { clearMocks() }
})
