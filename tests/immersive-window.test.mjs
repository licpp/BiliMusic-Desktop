import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { build } from 'esbuild'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'
const output = await build({ entryPoints: ['src/services/immersiveWindow.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'platform', setup(b) {
    b.onResolve({ filter: /^\.\/platform$/ }, () => ({ path: 'platform', namespace: 'test' }))
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const isOHOS = false; export const isAndroid = globalThis.testAndroid; export const isIOS = globalThis.testIOS; export const isMobile = isAndroid || isIOS' }))
  } }],
})
function setup(os) {
  globalThis.isTauri = true; globalThis.testAndroid = os === 'android'; globalThis.testIOS = os === 'ios'
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: os === 'windows' ? 'Windows NT' : os === 'macos' ? 'Macintosh' : 'Android' } })
  globalThis.window = { crypto: webcrypto }
  const calls = []
  mockIPC((command, args) => {
    calls.push({ command, args })
  })
  window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: 'main' } }
  const m = { exports: {} }; new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
  return { set: m.exports.setImmersiveWindow, calls }
}
for (const os of ['windows', 'macos']) {
  test(`${os} keeps the desktop viewport fixed when opening and closing lyrics`, async () => {
    const { set, calls } = setup(os)
    try {
      await Promise.all([set(true), set(false)])
      assert.deepEqual(calls, [])
    } finally { clearMocks() }
  })
}
test('Android immersive mode uses the authorized native player control command', async () => {
  const { set, calls } = setup('android')
  try {
    await Promise.all([set(true), set(false)])
    assert.deepEqual(calls.map(c => [c.command,c.args.action,c.args.value]), [['plugin:android-player|control','immersive',1],['plugin:android-player|control','immersive',0]])
  } finally { clearMocks() }
})

test('iOS immersive mode uses native control without desktop window APIs', async () => {
  const { set, calls } = setup('ios')
  try {
    await Promise.all([set(true), set(false)])
    assert.deepEqual(calls.map(c => [c.command,c.args.action,c.args.value]), [['plugin:ios-player|control','immersive',1],['plugin:ios-player|control','immersive',0]])
  } finally { clearMocks() }
})
