import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const output = await build({
  entryPoints: ['src/services/backgroundSync.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'statistics-boundaries', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'invoke', namespace: 'fixture' }))
    builder.onResolve({ filter: /accountScope$/ }, () => ({ path: 'account', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'invoke'
      ? 'export const invoke=(...args)=>globalThis.statisticsSyncTest.invoke(...args)'
      : 'export const accountEpoch=()=>globalThis.statisticsSyncTest.epoch' }))
  } }],
})
const flush = () => new Promise(setImmediate)
if (!globalThis.CustomEvent) globalThis.CustomEvent = class extends Event { constructor(type, init) { super(type); this.detail = init?.detail } }
function setup(t, invoke = async () => ({ statistics: false })) {
  const fixture = { epoch: 0, calls: [], invalidations: [], library: [] }
  fixture.invoke = (...args) => { fixture.calls.push(args); return invoke(...args) }
  globalThis.statisticsSyncTest = fixture
  globalThis.window = Object.assign(new EventTarget(), { setInterval(fn) { fixture.tick = fn; return 1 }, clearInterval() {} })
  globalThis.document = Object.assign(new EventTarget(), { hidden: false })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  fixture.stop = module.exports.startBackgroundSync({ invalidateQueries: async args => fixture.invalidations.push(args) }, async outcome => fixture.library.push(outcome))
  t.after(fixture.stop)
  return fixture
}
test('one lifecycle bridge reports hints; the Rust policy owns cadence', async t => {
  const f = setup(t)
  await flush()
  assert.deepEqual(f.calls, [['sync_background', { hint: 'configured' }]])
  f.tick(); await flush()
  window.dispatchEvent(new Event('bilimusic-data-changed')); await flush()
  window.dispatchEvent(new Event('bilimusic-statistics-sync-requested')); await flush()
  assert.deepEqual(f.calls.map(c => c[1].hint), ['configured', 'tick', 'data', 'statistics'])
  assert.equal(f.invalidations.length, 0, 'an admission-only heartbeat does not refetch UI data')
})
test('switching accounts suppresses old results and follows up for the new account', async t => {
  let release
  const f = setup(t, () => new Promise(resolve => { release = resolve }))
  const finishOld = release
  f.epoch++
  window.dispatchEvent(new Event('bilimusic-account-changing'))
  f.tick(); await flush()
  assert.equal(f.calls.length, 1)
  window.dispatchEvent(new Event('bilimusic-account-changed'))
  const finishNew = release
  finishOld({ statistics: true, library: { changed: true, conflicts: [] } }); await flush()
  assert.equal(f.invalidations.length, 0)
  assert.equal(f.library.length, 0)
  finishNew({ statistics: true }); await flush()
  assert.equal(f.invalidations.length, 1)
})
test('hidden and stopped views never start work; resume and network recovery report hints', async t => {
  const f = setup(t); await flush()
  document.hidden = true
  window.dispatchEvent(new Event('online')); f.tick(); await flush()
  assert.equal(f.calls.length, 1)
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange')); await flush()
  window.dispatchEvent(new Event('online')); await flush()
  assert.deepEqual(f.calls.map(c => c[1].hint), ['configured', 'foreground', 'online'])
  f.stop(); window.dispatchEvent(new Event('online')); f.tick(); await flush()
  assert.equal(f.calls.length, 3)
})
test('library and statistics outcomes refresh independently', async t => {
  const f = setup(t, async () => ({ library: { changed: true, conflicts: [] }, statisticsError: 'offline' }))
  await flush()
  assert.equal(f.library.length, 1)
  assert.deepEqual(f.invalidations, [{ queryKey: ['listening-statistics'] }, { queryKey: ['sync-status'] }])
})
test('IPC failures do not produce a frontend retry loop', async t => {
  const f = setup(t, async () => { throw new Error('offline') }); await flush()
  assert.equal(f.calls.length, 1)
  assert.equal(f.invalidations.length, 0)
  f.tick(); await flush()
  assert.equal(f.calls.length, 2)
})
