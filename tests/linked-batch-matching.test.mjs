import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

const { outputFiles: [bundle] } = await build({
  entryPoints: ['src/services/linkedBatchMatching.ts'], bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['zustand'],
  plugins: [{ name: 'checkpoint-ipc', setup(builder) {
    builder.onResolve({ filter: /^(@tauri-apps\/api\/core|\.\/(accountScope|batchMatching|desktopApi|collectionTrack))$/ }, args => ({ path: args.path, namespace: 'job' }))
    builder.onLoad({ filter: /.*/, namespace: 'job' }, ({ path }) => ({ contents: {
      '@tauri-apps/api/core': 'export const invoke = (...args) => fixture.invoke(...args); export const isTauri = () => true',
      './accountScope': 'export const accountEpoch = () => fixture.epoch',
      './batchMatching': 'export const matchBatchTrack = (...args) => fixture.match(...args); export const notifyBatchLyrics = async () => {}',
      './desktopApi': 'export const getVideoParts = (...args) => fixture.detail(...args); export const toTrackInput = track => ({ id:track.id, bvid:track.source.bvid, cid:track.source.cid }); export const fromStoredTrack = input => input',
      './collectionTrack': 'export const toTrack = (detail, part) => ({ id: `bilibili:${detail.bvid}:${part.cid}`, source: { bvid:detail.bvid, cid:part.cid } })',
    }[path] }))
  } }],
})

const folderId = 42
const selected = Array.from({ length: 100 }, (_, i) => ({ source: { bvid: `BV${String(i + 1).padStart(10, '0')}` } }))
const callbacks = () => ({ onMatched() {}, onChanged() {} })

function setup() {
  const events = new EventTarget(), requests = [], matches = []
  let job, list = [], parts, counter = 0, changes = 0
  const expired = { code: 'bili_rate_limited', retryAt: 200_000 }
  const fixture = {
    epoch: 0, session: 'first-session', limited: true,
    detail: async (bvid, _refresh, options) => {
      requests.push({ bvid, options })
      if (bvid === selected[19].source.bvid && fixture.limited) throw expired
      return { bvid, parts: [{ cid: 1 }] }
    },
    match: async (track, check, _allowNew, lease) => {
      check()
      assert.equal(lease.session, fixture.session)
      matches.push(track.id)
      job.matched++
      advance()
      return { outcome: 'matched', track }
    },
    invoke: async (command, args) => {
      if (command === 'account_session') return fixture.session
      assert.equal(args.folderId, folderId)
      assert.equal(args.expectedSession, fixture.session)
      if (command === 'linked_batch_match_job') return snapshot()
      if (command === 'linked_batch_match_start') {
        if (args.bvids) {
          list = args.bvids
          parts = args.tracks
          job = { done: 0, total: list.length, matched: 0, skipped: 0, failed: 0, protected: 0, unmatched: 0, conflicts: 0 }
        }
        job = { ...job, runId: `run-${++counter}`, state: 'running', reason: undefined, retryAt: undefined }
        return snapshot()
      }
      assert.ok(command === 'linked_batch_match_update')
      assert.equal(args.runId, job.runId)
      changes++
      switch (args.update.kind) {
        case 'resolve': parts = args.update.tracks; break
        case 'pause': job = { ...job, state: 'paused', reason: args.update.reason, retryAt: args.update.retryAt }; break
        case 'cancel': job.state = 'cancelled'; break
        case 'finishTrack': job[args.update.outcome]++; advance(); break
        case 'skipVideo': advance(); break
        default: assert.fail(args.update.kind)
      }
      return snapshot()
    },
  }
  function advance() {
    if (parts?.length > 1) { parts = parts.slice(1); return }
    parts = undefined
    job.done++
    if (job.done === job.total) job.state = 'completed'
  }
  function snapshot() {
    if (!job) return null
    const next = job.state === 'running' || job.state === 'paused'
      ? { bvid: list[job.done], tracks: parts?.slice(0, 1) }
      : undefined
    return { ...job, next }
  }
  function reopen() {
    const module = { exports: {} }
    new Function('require', 'module', 'exports', 'window', 'fixture', bundle.text)(createRequire(import.meta.url), module, module.exports, events, fixture)
    return module.exports
  }
  return { fixture, reopen, requests, matches, events, snapshot, changes: () => changes }
}

test('a hold at item 20 preserves 19 results and reopening continues at item 20', async () => {
  const h = setup(), first = h.reopen()
  await first.runLinkedMatch(folderId, callbacks(), { tracks: selected })
  const stopped = first.useLinkedMatchJobs.getState()[folderId].job
  assert.deepEqual([stopped.state, stopped.reason, stopped.done, stopped.matched, stopped.retryAt], ['paused', 'rateLimited', 19, 19, 200_000])
  assert.equal(h.requests.length, 20)
  assert.equal(h.matches.length, 19)

  h.fixture.session = 'restarted-session'
  h.fixture.limited = false
  const reopened = h.reopen()
  await reopened.loadLinkedMatch(folderId)
  assert.equal(reopened.useLinkedMatchJobs.getState()[folderId].job.done, 19)
  assert.equal(h.requests.length, 20)
  await reopened.runLinkedMatch(folderId, callbacks())
  assert.deepEqual(h.requests[20], { bvid: selected[19].source.bvid, options: { background: true, resume: true } })
  assert.equal(reopened.useLinkedMatchJobs.getState()[folderId].job.state, 'completed')
  assert.equal(h.matches.length, 100)
  assert.equal(new Set(h.matches).size, 100)
  assert.deepEqual(h.requests.slice(21).map(r => r.bvid), selected.slice(20).map(row => row.source.bvid))
})

test('manual pause during a detail request prevents downstream writes and preserves the current video', async () => {
  const h = setup(), service = h.reopen()
  let release, requested
  const started = new Promise(resolve => { requested = resolve })
  h.fixture.detail = bvid => new Promise(resolve => {
    release = () => resolve({ bvid, parts: [{ cid: 1 }] })
    requested()
  })
  const task = service.runLinkedMatch(folderId, callbacks(), { tracks: selected.slice(0, 2) })
  await started
  await service.pauseLinkedMatch(folderId)
  release()
  await task
  assert.equal(h.snapshot().reason, 'user')
  assert.equal(h.snapshot().done, 0)
  assert.equal(h.changes(), 1)
  assert.deepEqual(h.matches, [])
})

test('an A → B → A account switch discards an in-flight detail rejection', async () => {
  const h = setup(), service = h.reopen()
  let rejectDetail, requested
  const started = new Promise(resolve => { requested = resolve })
  h.fixture.detail = () => new Promise((_, reject) => { rejectDetail = reject; requested() })
  const task = service.runLinkedMatch(folderId, callbacks(), { tracks: selected.slice(0, 2) })
  await started
  h.fixture.epoch += 2
  h.fixture.session = 'fresh-A'
  h.events.dispatchEvent(new Event('bilimusic-account-changing'))
  rejectDetail({ code: 'bili_verification_required' })
  await task
  assert.deepEqual(service.useLinkedMatchJobs.getState(), {})
  assert.equal(h.changes(), 0)
})

test('the expanded part selector matches exactly the selected CIDs without refetching the entire video', async () => {
  const h = setup(), service = h.reopen()
  const { bvid } = selected[0].source
  const tracks = [2, 4].map(cid => ({ id: `bilibili:${bvid}:${cid}`, source: { bvid, cid } }))
  await service.runLinkedMatch(folderId, callbacks(), { tracks, partsOnly: true })
  assert.deepEqual(h.matches, tracks.map(track => track.id))
  assert.equal(h.requests.length, 0)
  assert.equal(h.snapshot().total, 1)
})

test('a confirmed unavailable video is skipped and does not leave the entire job paused', async () => {
  const h = setup(), service = h.reopen()
  const getDetail = h.fixture.detail
  h.fixture.detail = async (bvid, ...args) => {
    if (bvid === selected[0].source.bvid) throw { code: 'source_unavailable' }
    return getDetail(bvid, ...args)
  }
  await service.runLinkedMatch(folderId, callbacks(), { tracks: selected.slice(0, 2) })
  assert.deepEqual(h.matches, [`bilibili:${selected[1].source.bvid}:1`])
  assert.equal(h.snapshot().state, 'completed')
})
