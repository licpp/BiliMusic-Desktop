import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const require = createRequire(import.meta.url)

async function bundle(entry, platform = {}) {
  const flags = { isOHOS: false, isAndroid: false, isIOS: false, isMobile: false, ...platform }
  const output = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external',
    plugins: [{ name: 'platform', setup(b) {
      b.onResolve({ filter: /^\.\/platform$/ }, () => ({ path: 'platform', namespace: 'test' }))
      b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export const isOHOS = ${flags.isOHOS}; export const isAndroid = ${flags.isAndroid}; export const isIOS = ${flags.isIOS}; export const isMobile = ${flags.isMobile}` }))
    } }],
  })
  return output.outputFiles[0].text
}

function evaluate(text, imports = require) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', text)(imports, module, module.exports)
  return module.exports
}

const domain = evaluate(await bundle('src/domain/theme.ts'))
const serviceText = await bundle('src/services/theme.ts')
const iosServiceText = await bundle('src/services/theme.ts', { isIOS: true, isMobile: true })

test('an unknown or missing stored value keeps the dark default', () => {
  assert.equal(domain.parseThemePreference('light'), 'light')
  assert.equal(domain.parseThemePreference('dark'), 'dark')
  assert.equal(domain.parseThemePreference('system'), 'system')
  assert.equal(domain.parseThemePreference(null), 'dark')
  assert.equal(domain.parseThemePreference(undefined), 'dark')
  assert.equal(domain.parseThemePreference('sepia'), 'dark')
})

test('an explicit preference wins over the system scheme', () => {
  assert.equal(domain.resolveTheme('light', 'dark'), 'light')
  assert.equal(domain.resolveTheme('dark', 'light'), 'dark')
  assert.equal(domain.resolveTheme('system', 'dark'), 'dark')
  assert.equal(domain.resolveTheme('system', 'light'), 'light')
})

test('the toggle walks dark, light and system, and skips system where it cannot resolve', () => {
  assert.equal(domain.nextThemePreference('dark', true), 'light')
  assert.equal(domain.nextThemePreference('light', true), 'system')
  assert.equal(domain.nextThemePreference('system', true), 'dark')
  assert.equal(domain.nextThemePreference('dark', false), 'light')
  assert.equal(domain.nextThemePreference('light', false), 'dark')
  assert.equal(domain.nextThemePreference('system', false), 'dark')
})

test('the toggle labels the state a click moves to', () => {
  assert.equal(domain.themeActionLabel('dark', true), '切换浅色主题')
  assert.equal(domain.themeActionLabel('light', true), '跟随系统主题')
  assert.equal(domain.themeActionLabel('system', true), '切换深色主题')
  assert.equal(domain.nextThemePreference('light', false), 'dark')
  assert.equal(domain.themeActionLabel('light', false), '切换深色主题')
  assert.equal(domain.themePreferenceLabel('system'), '跟随系统')
  assert.equal(domain.themePreferenceLabel('light'), '浅色')
  assert.equal(domain.themePreferenceLabel('dark'), '深色')
})

/** Minimal WebView surface: media query, storage and the two theme side effects. */
function environment({ stored, dark = false, supported = true, matchMedia = true } = {}) {
  const changes = new Set()
  const storage = new Map(stored === undefined ? [] : [['bilimusic-theme', stored]])
  const dataset = {}
  const meta = { content: undefined, setAttribute(name, value) { if (name === 'content') this.content = value } }
  const scheme = {
    media: supported ? '(prefers-color-scheme: dark)' : 'not all',
    matches: dark,
    addEventListener(type, listener) { if (type === 'change') changes.add(listener) },
    removeEventListener(type, listener) { if (type === 'change') changes.delete(listener) },
  }
  globalThis.window = {
    // Reduced motion short-circuits the view-transition path, so tests stay synchronous.
    ...(matchMedia ? { matchMedia: query => query === '(prefers-color-scheme: dark)' ? scheme : { matches: query === '(prefers-reduced-motion: reduce)', media: query, addEventListener() {}, removeEventListener() {} } } : {}),
  }
  globalThis.localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem(key, value) { storage.set(key, String(value)) },
    removeItem(key) { storage.delete(key) },
  }
  globalThis.document = {
    documentElement: { dataset }, visibilityState: 'visible',
    querySelector: selector => selector === 'meta[name="theme-color"]' ? meta : null,
    getElementById: () => null, createElement: () => ({}), body: { appendChild() {} },
  }
  return {
    dataset, meta, storage,
    setSystem(next) { scheme.matches = next; for (const listener of [...changes]) listener({ matches: next, media: scheme.media }) },
  }
}

test('a stored system preference resolves through the media query before the first render', () => {
  try {
    const env = environment({ stored: 'system', dark: true })
    const { useThemeStore } = evaluate(serviceText)
    assert.equal(useThemeStore.getState().preference, 'system')
    assert.equal(useThemeStore.getState().theme, 'dark')
    assert.equal(env.dataset.theme, 'dark')
    assert.equal(env.meta.content, '#071019')
  } finally { restore() }
})

test('following the system applies live OS changes in both directions', () => {
  try {
    const env = environment({ stored: 'light', dark: false })
    const { useThemeStore } = evaluate(serviceText)
    useThemeStore.getState().setTheme('system')
    assert.equal(useThemeStore.getState().theme, 'light')
    env.setSystem(true)
    assert.equal(useThemeStore.getState().theme, 'dark')
    assert.equal(env.dataset.theme, 'dark')
    assert.equal(env.meta.content, '#071019')
    env.setSystem(false)
    assert.equal(useThemeStore.getState().theme, 'light')
    assert.equal(env.dataset.theme, 'light')
    assert.equal(env.meta.content, '#f4f6fa')
  } finally { restore() }
})

test('an explicit preference ignores the OS scheme and is persisted', () => {
  try {
    const env = environment({ stored: 'dark', dark: true })
    const { useThemeStore } = evaluate(serviceText)
    useThemeStore.getState().setTheme('light')
    env.setSystem(false)
    env.setSystem(true)
    assert.equal(useThemeStore.getState().preference, 'light')
    assert.equal(useThemeStore.getState().theme, 'light')
    assert.equal(env.dataset.theme, 'light')
    assert.equal(env.storage.get('bilimusic-theme'), 'light')
  } finally { restore() }
})

test('cycling reaches the system state and stores it', () => {
  try {
    const env = environment({ stored: 'dark', dark: false })
    const { useThemeStore } = evaluate(serviceText)
    useThemeStore.getState().cycleTheme()
    assert.equal(useThemeStore.getState().preference, 'light')
    assert.equal(env.storage.get('bilimusic-theme'), 'light')
    useThemeStore.getState().cycleTheme()
    assert.equal(useThemeStore.getState().preference, 'system')
    assert.equal(useThemeStore.getState().theme, 'light')
    // Storing the resolved colour instead of the preference would strand the
    // user on an explicit theme after the next launch.
    assert.equal(env.storage.get('bilimusic-theme'), 'system')
    env.setSystem(true)
    assert.equal(useThemeStore.getState().theme, 'dark')
    useThemeStore.getState().cycleTheme()
    assert.equal(useThemeStore.getState().preference, 'dark')
    assert.equal(env.storage.get('bilimusic-theme'), 'dark')
  } finally { restore() }
})

test('a platform without a system scheme never enters the system state', () => {
  try {
    const env = environment({ stored: 'system', dark: false, supported: false })
    const { useThemeStore, systemThemeSupported } = evaluate(serviceText)
    assert.equal(systemThemeSupported(), false)
    assert.equal(useThemeStore.getState().preference, 'dark')
    assert.equal(useThemeStore.getState().theme, 'dark')
    useThemeStore.getState().setTheme('system')
    assert.equal(useThemeStore.getState().preference, 'dark')
    assert.equal(env.dataset.theme, 'dark')
    useThemeStore.getState().cycleTheme()
    assert.equal(useThemeStore.getState().preference, 'light')
    useThemeStore.getState().cycleTheme()
    assert.equal(useThemeStore.getState().preference, 'dark')
  } finally { restore() }
})

/** iOS bridge: the player plugin is a Tauri command, so record what the service sends. */
function iosImports(calls) {
  return spec => {
    if (spec === '@tauri-apps/api/core') {
      return { invoke: async (command, args) => { calls.push({ command, args }) }, isTauri: () => true }
    }
    if (spec === '@tauri-apps/api/window') {
      return { getCurrentWindow: () => ({ setTheme: async () => undefined }) }
    }
    return require(spec)
  }
}

test('iOS follows the system by handing the window back to the OS', () => {
  try {
    const env = environment({ stored: 'dark', dark: true })
    const calls = []
    const { useThemeStore, systemThemeSupported } = evaluate(iosServiceText, iosImports(calls))
    assert.equal(systemThemeSupported(), true)
    useThemeStore.getState().setTheme('system')
    // The preference, not the resolved colour, lets the plugin unset its override.
    assert.deepEqual(calls.at(-1), { command: 'plugin:ios-player|control', args: { action: 'theme', value: 0, theme: 'system' } })
    env.setSystem(false)
    assert.equal(useThemeStore.getState().preference, 'system')
    assert.equal(useThemeStore.getState().theme, 'light')
    assert.equal(env.dataset.theme, 'light')
    useThemeStore.getState().setTheme('light')
    assert.deepEqual(calls.at(-1), { command: 'plugin:ios-player|control', args: { action: 'theme', value: 1, theme: 'light' } })
  } finally { restore() }
})

test('the iOS plugin can unset the window override and survives a cold launch', async () => {
  const native = await readFile('native/ios-player/ios/Sources/PlayerPlugin.swift', 'utf8')
  // `.unspecified` is what makes WKWebView report the OS scheme again.
  assert.match(native, /overrideUserInterfaceStyle = \.unspecified/)
  // The preference, including `system`, must outlive the WebView.
  assert.match(native, /bilimusic-theme-preference/)
  assert.match(native, /let theme: String\?/)
})

test('a WebView without matchMedia keeps working on an explicit theme', () => {
  try {
    const env = environment({ stored: 'system', matchMedia: false })
    const { useThemeStore, systemThemeSupported } = evaluate(serviceText)
    assert.equal(systemThemeSupported(), false)
    assert.equal(useThemeStore.getState().preference, 'dark')
    assert.equal(useThemeStore.getState().theme, 'dark')
    assert.equal(env.dataset.theme, 'dark')
  } finally { restore() }
})

/** Desktop bridge: `@tauri-apps/api` is external, so swap it for a call log. */
function desktopImports(calls) {
  return spec => {
    if (spec === '@tauri-apps/api/core') return { invoke: async () => undefined, isTauri: () => true }
    if (spec === '@tauri-apps/api/window') {
      return { getCurrentWindow: () => ({ setTheme(theme) { calls.push(theme); return Promise.resolve() } }) }
    }
    return require(spec)
  }
}

test('desktop follows the OS by handing the native window theme back instead of pinning a colour', async () => {
  try {
    environment({ stored: 'light', dark: false })
    const calls = []
    const { useThemeStore } = evaluate(serviceText, desktopImports(calls))
    await Promise.resolve()
    assert.deepEqual(calls, ['light'])
    useThemeStore.getState().setTheme('system')
    await Promise.resolve()
    // null is the only value that lets the OS drive the window frame.
    assert.equal(calls.at(-1), null)
    useThemeStore.getState().setTheme('dark')
    await Promise.resolve()
    assert.equal(calls.at(-1), 'dark')
  } finally { restore() }
})

const bootSource = await readFile('public/boot.js', 'utf8')

function bootDataset({ stored, dark = false, supported = true, matchMedia = true } = {}) {
  const dataset = {}
  const storage = new Map(stored === undefined ? [] : [['bilimusic-theme', stored]])
  const window = {}
  if (matchMedia) window.matchMedia = query => ({
    media: supported ? query : 'not all', matches: dark,
    addEventListener() {}, removeEventListener() {},
  })
  const context = vm.createContext({
    localStorage: { getItem: key => (storage.has(key) ? storage.get(key) : null) },
    document: { documentElement: { dataset }, addEventListener() {}, querySelector: () => null },
    window,
  })
  vm.runInContext(bootSource, context)
  return dataset.theme
}

test('the first paint resolves the stored preference before the app loads', () => {
  assert.equal(bootDataset({ stored: 'light' }), 'light')
  assert.equal(bootDataset({ stored: 'dark' }), 'dark')
  assert.equal(bootDataset({}), 'dark')
  assert.equal(bootDataset({ stored: 'sepia' }), 'dark')
  assert.equal(bootDataset({ stored: 'system', dark: true }), 'dark')
  assert.equal(bootDataset({ stored: 'system', dark: false }), 'light')
  assert.equal(bootDataset({ stored: 'system', dark: true, supported: false }), 'dark')
  assert.equal(bootDataset({ stored: 'system', dark: false, matchMedia: false }), 'dark')
})

function restore() {
  delete globalThis.window
  delete globalThis.localStorage
  delete globalThis.document
}
