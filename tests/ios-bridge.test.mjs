import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { build } from 'esbuild'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'
const [manifest, defaults, swift] = await Promise.all([
  readFile('native/ios-player/build.rs','utf8'), readFile('native/ios-player/permissions/default.toml','utf8'), readFile('native/ios-player/ios/Sources/PlayerPlugin.swift','utf8'),
])
const strings = text => [...text.matchAll(/"([^"]+)"/g)].map(m => m[1])
const commands = new Set(strings(manifest.match(/Builder::new\(&\[([\s\S]*?)\]/)[1]))
const permissions = new Set(strings(defaults.match(/permissions\s*=\s*\[([\s\S]*?)\]/)[1]))
const output = await build({ entryPoints:['src/features/player/iosAudio.ts'], bundle:true, write:false, format:'cjs', platform:'node' })
test('iOS SDK listener, queue and playback calls satisfy ACL and discard stale native revisions', async () => {
  globalThis.window = { crypto: webcrypto }
  let handler; const calls = []
  mockIPC((full, payload) => {
    const command = full.split('|')[1]
    assert.ok(commands.has(command), `${command} missing from native command manifest`)
    assert.ok(permissions.has(`allow-${command.replaceAll('_','-')}`), `${command} not permitted`)
    assert.ok(new RegExp(`@objc public func ${command}\\(`).test(swift), `${command} has no exported Swift selector`)
    calls.push(command)
    if (command === 'register_listener') handler = payload.handler
    if (command === 'snapshot') return {id:'test',status:'playing',position:5,revision:2}
  })
  try {
    const m = {exports:{}}
    new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
    const audio = m.exports, states = []
    const subscription = await audio.observeIOSAudio(state => states.push(state))
    const emit = (index, revision, position) => window.__TAURI_INTERNALS__.runCallback(handler.id, { index, message: {id:'test',status:'playing',position,duration:120,revision} })
    emit(0,2,5); emit(1,1,1)
    assert.equal(states.length,1); assert.equal(states[0].position,5)
    const track = {id:'test',title:'song'}
    await audio.prepareIOSAudio(track)
    await audio.syncIOSQueue([track],'all',false)
    await audio.playIOSAudio(track,'http://127.0.0.1:1234/token/media',0,.7)
    await audio.snapshotIOSAudio(); await subscription.unregister()
    assert.deepEqual(calls,['register_listener','control','queue','play','snapshot','remove_listener'])
    assert.ok(!commands.has('secret'), 'Keychain access must remain Rust-only')
  } finally { clearMocks() }
})
