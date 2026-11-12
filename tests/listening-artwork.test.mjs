import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const output = await build({ entryPoints: ['src/services/listeningArtwork.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'read-only-artwork', setup(b) {
    b.onResolve({ filter: /^\.\/(desktopApi|accountScope)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path.endsWith('accountScope')
      ? 'export const accountEpoch=()=>globalThis.listeningArtworkTest.epoch'
      : 'export const getVideoParts=(bvid)=>globalThis.listeningArtworkTest.get(bvid)' }))
  } }],
})
const bv = ['BV1xx411c7mD', 'BV1xx411c7mE', 'BV1xx411c7mF']
const detail = coverUrl => ({ coverUrl, parts: [{ cid: 1, coverUrl: `${coverUrl}-part` }, { cid: 2 }] })
function setup(handler) {
  const f = globalThis.listeningArtworkTest = { epoch: 0, calls: [], get(bvid) { this.calls.push(bvid); return handler(bvid) } }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  return { f, cover: module.exports.getListeningArtwork }
}

test('remote-only statistics can resolve covers by identity without importing or recording a song', async () => {
  const { f, cover } = setup(async () => detail('https://cover'))
  assert.equal(await cover(`bilibili:${bv[0]}:1`), 'https://cover-part')
  assert.equal(await cover(`bilibili:${bv[0]}:2`), 'https://cover')
  assert.equal(await cover('local:removed'), undefined)
  assert.equal(await cover('bilibili:invalid:1'), undefined)
  assert.equal(f.calls.length, 2)
})

test('multiple parts share one request and cover hydration limits native concurrency to two', async () => {
  const pending = new Map()
  const { f, cover } = setup(bvid => new Promise(resolve => pending.set(bvid, resolve)))
  const first = cover(`bilibili:${bv[0]}:1`), secondPart = cover(`bilibili:${bv[0]}:2`)
  const second = cover(`bilibili:${bv[1]}:1`), third = cover(`bilibili:${bv[2]}:1`)
  assert.deepEqual(f.calls, bv.slice(0, 2))
  pending.get(bv[0])(detail('first'))
  assert.deepEqual(await Promise.all([first, secondPart]), ['first-part', 'first'])
  await new Promise(setImmediate)
  assert.deepEqual(f.calls, bv)
  pending.get(bv[1])(detail('second')); pending.get(bv[2])(detail('third'))
  assert.deepEqual(await Promise.all([second, third]), ['second-part', 'third-part'])
})

test('account switches discard both queued and in-flight cover results', async () => {
  const pending = new Map()
  const { f, cover } = setup(bvid => new Promise(resolve => pending.set(bvid, resolve)))
  const results = Promise.allSettled(bv.map(bvid => cover(`bilibili:${bvid}:1`)))
  f.epoch++
  pending.get(bv[0])(detail('old-account')); pending.get(bv[1])(detail('old-account'))
  const settled = await results
  assert.ok(settled.every(r => r.status === 'rejected'))
  assert.equal(f.calls.length, 2)
})

test('source rate limits cool down missing-cover requests instead of flooding Bilibili', async () => {
  const { f, cover } = setup(async () => { throw new Error('HTTP 429') })
  await assert.rejects(cover(`bilibili:${bv[0]}:1`), /429/)
  await new Promise(setImmediate)
  await assert.rejects(cover(`bilibili:${bv[1]}:1`), /暂缓/)
  assert.equal(f.calls.length, 1)
})
