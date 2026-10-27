import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { build } from 'esbuild'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'
import { getCurrentWindow } from '@tauri-apps/api/window'
const capabilities = JSON.parse(await readFile('src-tauri/capabilities/immersive-window.json', 'utf8'))
const output = await build({ entryPoints: ['src/services/immersiveWindow.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'platform', setup(b) {
    b.onResolve({ filter: /^\.\/platform$/ }, () => ({ path: 'platform', namespace: 'test' }))
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const isAndroid = globalThis.testAndroid' }))
  } }],
})
function setup(os) {
  globalThis.isTauri = true; globalThis.testAndroid = os === 'android'
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: os === 'windows' ? 'Windows NT' : os === 'macos' ? 'Macintosh' : 'Android' } })
  globalThis.window = { crypto: webcrypto }
  const calls = []
  mockIPC((command, args) => {
    if (os !== 'android') assert.ok(capabilities.permissions.includes(`core:window:allow-${command.split('|')[1].replaceAll('_','-')}`), command)
    calls.push({ command, args })
  })
  window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: 'main' } }
  const m = { exports: {} }; new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
  return { set: m.exports.setImmersiveWindow, calls }
}
test('Windows immersive frame is restored on quick open/close and window controls remain authorized', async () => {
  const { set, calls } = setup('windows')
  try {
    await Promise.all([set(true), set(false)])
    assert.deepEqual(calls.map(c => c.args.value), [false, true])
    await getCurrentWindow().minimize(); await getCurrentWindow().toggleMaximize(); await getCurrentWindow().close()
    assert.deepEqual(calls.slice(2).map(c => c.command.split('|')[1]), ['minimize','toggle_maximize','close'])
  } finally { clearMocks() }
})
test('macOS keeps native controls using the overlay title bar and restores the normal title bar', async () => {
  const { set, calls } = setup('macos')
  try {
    await Promise.all([set(true), set(false)])
    assert.deepEqual(calls.map(c => c.args.value), ['overlay','visible'])
  } finally { clearMocks() }
})
test('Android immersive mode uses the authorized native player control command', async () => {
  const { set, calls } = setup('android')
  try {
    await Promise.all([set(true), set(false)])
    assert.deepEqual(calls.map(c => [c.command,c.args.action,c.args.value]), [['plugin:android-player|control','immersive',1],['plugin:android-player|control','immersive',0]])
  } finally { clearMocks() }
})
