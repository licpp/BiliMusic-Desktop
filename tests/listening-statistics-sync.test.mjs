import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const output = await build({
  entryPoints: ['src/services/listeningStatisticsSync.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'statistics-boundaries', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'invoke', namespace: 'fixture' }))
    builder.onResolve({ filter: /accountScope$/ }, () => ({ path: 'account', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'invoke'
      ? 'export const invoke=(...args)=>globalThis.statisticsSyncTest.invoke(...args)'
      : 'export const accountEpoch=()=>globalThis.statisticsSyncTest.epoch' }))
  } }],
})
const flush = () => new Promise(setImmediate)
function setup(t, invoke = async () => {}) {
  const fixture = { epoch: 0, calls: [], invalidations: [] }
  fixture.invoke = (...args) => { fixture.calls.push(args); return invoke(...args) }
  globalThis.statisticsSyncTest = fixture
  globalThis.window = Object.assign(new EventTarget(), { setInterval(fn) { fixture.tick = fn; return 1 }, clearInterval() {} })
  globalThis.document = Object.assign(new EventTarget(), { hidden: false })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  fixture.stop = module.exports.startAccountStatisticsSync({ invalidateQueries: async args => fixture.invalidations.push(args) })
  t.after(fixture.stop)
  return fixture
}
test('account statistics run without consulting library sync settings and batch automatic requests', async t => {
  const f = setup(t)
  await flush()
  assert.deepEqual(f.calls, [['listening_sync']])
  f.tick(); await flush()
  assert.equal(f.calls.length, 1, 'do not spend WebDAV quota on every timer tick')
  window.dispatchEvent(new Event('bilimusic-statistics-sync-requested')); await flush()
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.invalidations[0], { queryKey: ['listening-statistics'] })
})
test('switching accounts during an upload suppresses old results and promptly syncs the new account', async t => {
  let release
  const f = setup(t, () => new Promise(resolve => { release = resolve }))
  f.epoch++
  window.dispatchEvent(new Event('bilimusic-account-changing'))
  window.dispatchEvent(new Event('bilimusic-account-changed'))
  assert.equal(f.calls.length, 1)
  release(); await flush()
  assert.equal(f.calls.length, 2, 'account change while busy must not defer the new account for 15 minutes')
  assert.equal(f.invalidations.length, 0)
  release(); await flush()
  assert.equal(f.invalidations.length, 1)
})
test('network recovery and foreground resume sync; hidden views do not start requests', async t => {
  const f = setup(t); await flush()
  document.hidden = true
  window.dispatchEvent(new Event('online')); await flush()
  assert.equal(f.calls.length, 1)
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange')); await flush()
  window.dispatchEvent(new Event('online')); await flush()
  assert.equal(f.calls.length, 3)
  f.stop(); window.dispatchEvent(new Event('online')); await flush()
  assert.equal(f.calls.length, 3)
})
test('a failed sync refreshes the visible error and remains retryable', async t => {
  const f = setup(t, async () => { throw new Error('offline') }); await flush()
  assert.equal(f.invalidations.length, 1)
  window.dispatchEvent(new Event('online')); await flush()
  assert.equal(f.calls.length, 2)
  assert.equal(f.invalidations.length, 2)
})
