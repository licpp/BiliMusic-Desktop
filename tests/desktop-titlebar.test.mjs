import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'

const service = await build({
  entryPoints: ['src/services/desktopWindow.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'platform', setup(b) {
    b.onResolve({ filter: /^\.\/platform$/ }, () => ({ path: 'platform', namespace: 'test' }))
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const isMobile = globalThis.testMobile === true' }))
  } }],
})
const domain = await build({ entryPoints: ['src/domain/windowChrome.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' })

function load(built) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  return module.exports
}

/** Fresh module per test: `nativeDesktop` is decided once at import time. */
function setup({ mobile = false, userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', native = true } = {}) {
  const original = {
    isTauri: globalThis.isTauri,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    window: globalThis.window,
  }
  globalThis.isTauri = native
  globalThis.testMobile = mobile
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent } })
  globalThis.window = { crypto: webcrypto }
  const calls = []
  mockIPC((command, args) => {
    calls.push({ command, args })
    if (command === 'plugin:window|is_maximized') return globalThis.testMaximized === true
    if (command === 'plugin:event|listen') return 1
  })
  window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: 'main' } }
  const module = load(service)
  return {
    module, calls,
    restore() {
      clearMocks()
      globalThis.isTauri = original.isTauri
      globalThis.testMobile = undefined
      globalThis.testMaximized = undefined
      if (original.navigator) Object.defineProperty(globalThis, 'navigator', original.navigator)
      else delete globalThis.navigator
      globalThis.window = original.window
    },
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('desktop platform detection separates macOS traffic lights from Windows and Linux', () => {
  const chrome = load(domain)
  assert.equal(chrome.desktopPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), 'macos')
  assert.equal(chrome.desktopPlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'linux')
  assert.equal(chrome.desktopPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows')
  assert.equal(chrome.desktopPlatform('Mozilla/5.0 (Linux; Android 14)'), 'windows')
  assert.deepEqual(chrome.windowControlOrder('macos'), ['close', 'minimize', 'toggle-maximize'])
  assert.deepEqual(chrome.windowControlOrder('windows'), ['minimize', 'toggle-maximize', 'close'])
  assert.deepEqual(chrome.windowControlOrder('linux'), ['minimize', 'toggle-maximize', 'close'])
  assert.equal(chrome.windowControlsOnLeft('macos'), true)
  assert.equal(chrome.windowControlsOnLeft('linux'), false)
  assert.equal(chrome.windowControlLabel('toggle-maximize', false), '最大化窗口')
  assert.equal(chrome.windowControlLabel('toggle-maximize', true), '还原窗口')
})

test('desktop controls call the authorized main-window commands in order', async () => {
  const { module, calls, restore } = setup()
  try {
    assert.equal(module.desktopChrome, true)
    await module.minimizeMainWindow()
    await module.toggleMaximizeMainWindow()
    await module.closeMainWindow()
    assert.deepEqual(calls.map(call => call.command), [
      'plugin:window|minimize', 'plugin:window|toggle_maximize', 'plugin:window|close',
    ])
    for (const call of calls) assert.deepEqual(call.args, { label: 'main' })
  } finally { restore() }
})

test('the maximise state follows resizes and the listener stops on cleanup', async () => {
  const { module, calls, restore } = setup()
  try {
    globalThis.testMaximized = true
    const states = []
    const stop = module.watchMaximized(value => states.push(value))
    await settle()
    assert.deepEqual(states, [true])
    assert.ok(calls.some(call => call.command === 'plugin:window|is_maximized'))
    assert.ok(calls.some(call => call.command === 'plugin:event|listen'))
    stop()
    await settle()
    assert.ok(calls.some(call => call.command === 'plugin:event|unlisten'))
  } finally { restore() }
})

test('mobile and browser shells render no chrome and issue no window commands', async () => {
  const mobile = setup({ mobile: true })
  try {
    assert.equal(mobile.module.desktopChrome, false)
    await mobile.module.minimizeMainWindow()
    await mobile.module.toggleMaximizeMainWindow()
    await mobile.module.closeMainWindow()
    mobile.module.watchMaximized(() => {})()
    assert.deepEqual(mobile.calls, [])
  } finally { mobile.restore() }

  const browser = setup({ native: false })
  try {
    assert.equal(browser.module.desktopChrome, true)
    await browser.module.minimizeMainWindow()
    await browser.module.toggleMaximizeMainWindow()
    await browser.module.closeMainWindow()
    assert.deepEqual(browser.calls, [])
  } finally { browser.restore() }
})

test('the shell drops the system header and grants every command the titlebar uses', async () => {
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
  assert.equal(config.app.windows.find(entry => entry.label === 'main')?.decorations, false)
  const capability = JSON.parse(await readFile('src-tauri/capabilities/desktop-window-controls.json', 'utf8'))
  assert.deepEqual(capability.windows, ['main'])
  assert.deepEqual(capability.platforms, ['macOS', 'windows', 'linux'])
  for (const permission of [
    'core:window:allow-minimize',
    'core:window:allow-toggle-maximize',
    // The drag region's own double-click handler.
    'core:window:allow-internal-toggle-maximize',
    'core:window:allow-close',
    'core:window:allow-start-dragging',
    'core:window:allow-is-maximized',
  ]) {
    assert.ok(capability.permissions.includes(permission), `${permission} is missing`)
  }
})
