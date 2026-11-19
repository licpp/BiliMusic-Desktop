import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['src/services/immersiveWindow.ts'], bundle: true, write: false, format: 'cjs',
  define: { 'import.meta.env.DEV': 'false' },
  plugins: [{ name: 'harmony-window', setup(bundle) {
    bundle.onResolve({ filter: /^(\.\/platform|@tauri-apps\/api\/(core|window))$/ }, ({ path }) => ({ path, namespace: 'mock' }))
    bundle.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: {
      './platform': 'export const isOHOS = true, isMobile = true, isIOS = false, isAndroid = false',
      '@tauri-apps/api/core': 'export const isTauri = () => true, invoke = globalThis.ohosWindowTestInvoke',
      '@tauri-apps/api/window': 'export const getCurrentWindow = () => undefined',
    }[path] }))
  } }],
})

test('Harmony loads safe insets at startup, preserves them across pages and ignores stale geometry', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const style = new Map()
  const attributes = new Set()
  const document = Object.assign(new EventTarget(), { hidden: false, documentElement: {
    toggleAttribute: (key, active) => active ? attributes.add(key) : attributes.delete(key),
    style: {
      setProperty: (key, value) => style.set(key, value),
      removeProperty: (key) => style.delete(key),
    },
  } })
  const window = Object.assign(new EventTarget(), { setTimeout, clearTimeout, visualViewport: new EventTarget() })
  const insets = (top, right, bottom, left) => ({ active: true, top, right, bottom, left })
  let response = insets(42, 0, 28, 0)
  let delayedReply
  const controls = []
  const invoke = async (command, args) => {
    assert.equal(command, 'plugin:ohos-player|control')
    assert.deepEqual(args, { action: 'windowInsets' })
    controls.push(args)
    return response
  }
  const module = { exports: {} }
  new Function('module', 'document', 'window', 'globalThis', outputFiles[0].text)(module, document, window, { ohosWindowTestInvoke: invoke })
  const { installOHOSWindowInsets, setImmersiveWindow } = module.exports
  const flush = async () => {
    context.mock.timers.tick(80)
    await new Promise(setImmediate)
  }

  await installOHOSWindowInsets()
  assert.equal(style.get('--native-safe-top'), '42px')
  assert.equal(style.get('--native-safe-bottom'), '28px')
  await setImmersiveWindow(true)
  await setImmersiveWindow(false)
  assert.equal(controls.length, 1)
  assert.equal(attributes.has('data-ohos-edge-to-edge'), true)
  assert.equal(style.get('--native-safe-top'), '42px')

  response = insets(0, 0, 16, 36)
  window.dispatchEvent(new Event('resize'))
  window.visualViewport.dispatchEvent(new Event('resize'))
  const beforeGeometry = controls.length
  await flush()
  assert.equal(controls.length, beforeGeometry + 1)
  assert.equal(style.get('--native-safe-top'), '0px')
  assert.equal(style.get('--native-safe-left'), '36px')

  response = insets(0, 30, 16, 0)
  document.hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  assert.equal(style.get('--native-safe-left'), '36px')
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()
  assert.equal(style.get('--native-safe-right'), '30px')

  response = new Promise((resolve) => { delayedReply = resolve })
  window.dispatchEvent(new Event('resize'))
  await flush()
  response = { active: false }
  window.dispatchEvent(new Event('resize'))
  await flush()
  assert.equal(attributes.has('data-ohos-edge-to-edge'), false)
  assert.equal(style.size, 0)
  delayedReply(insets(42, 0, 28, 0))
  await flush()
  assert.equal(style.size, 0)
  assert.equal(attributes.has('data-ohos-edge-to-edge'), false)
})
