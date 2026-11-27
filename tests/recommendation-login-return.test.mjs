import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

// The marker lives in localStorage, which Node does not provide by default.
const store = new Map()
const localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)) },
  removeItem: key => { store.delete(key) },
}
globalThis.localStorage = localStorage

const built = await build({ entryPoints: ['src/services/recommendationLoginReturn.ts'], bundle: true, write: false, format: 'esm' })
const { markWebLoginReturn, peekWebLoginReturn, clearWebLoginReturn, sourceAddedByLogin, outcomeForAttempt } =
  await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const KEY = 'bilimusic.recommendation.web-login'

test.beforeEach(() => store.clear())

test('a login marker survives the reload and reports the sources that existed before it', () => {
  markWebLoginReturn(['source-1'], 1_000)
  assert.deepEqual(peekWebLoginReturn(2_000), { startedAt: 1_000, sourceIds: ['source-1'] })
})

test('the marker is one-shot: clearing it stops the dialog from reopening', () => {
  markWebLoginReturn([], 1_000)
  clearWebLoginReturn()
  assert.equal(peekWebLoginReturn(2_000), undefined)
})

test('a marker abandoned by a killed app expires instead of opening the dialog later', () => {
  markWebLoginReturn([], 1_000)
  assert.equal(peekWebLoginReturn(1_000 + 15 * 60_000 + 1), undefined)
  // Expired markers are removed, not left to expire again on every read.
  assert.equal(store.has(KEY), false)
})

test('a marker from the future cannot pin the marker open after a clock change', () => {
  markWebLoginReturn([], 10_000)
  assert.equal(peekWebLoginReturn(9_000), undefined)
})

test('a corrupted marker is ignored and cleaned up', () => {
  store.set(KEY, '{not json')
  assert.equal(peekWebLoginReturn(1_000), undefined)
  assert.equal(store.has(KEY), false)
  store.set(KEY, JSON.stringify({ startedAt: 'soon', sourceIds: [] }))
  assert.equal(peekWebLoginReturn(1_000), undefined)
  assert.equal(store.has(KEY), false)
})

test('the marker still works when storage refuses writes', () => {
  const failing = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('quota') } }
  globalThis.localStorage = failing
  try {
    assert.doesNotThrow(() => markWebLoginReturn(['source-1'], 1_000))
    assert.equal(peekWebLoginReturn(1_000), undefined)
    assert.doesNotThrow(() => clearWebLoginReturn())
  } finally {
    globalThis.localStorage = localStorage
  }
})

test('the source the login added is the one that was not there before', () => {
  const marker = { startedAt: 1_000, sourceIds: ['source-1'] }
  assert.deepEqual(sourceAddedByLogin([{ id: 'source-1' }, { id: 'source-2' }], marker), { id: 'source-2' })
  assert.equal(sourceAddedByLogin([{ id: 'source-1' }], marker), undefined)
})

test('only the outcome of this attempt is read, not one left by an earlier login', () => {
  const marker = { startedAt: 1_000, sourceIds: [] }
  // The login ends after the marker is written, so its outcome is never older.
  assert.deepEqual(outcomeForAttempt({ finishedAt: 1_500, error: { code: 'netease_timeout' } }, marker), {
    finishedAt: 1_500,
    error: { code: 'netease_timeout' },
  })
  assert.equal(outcomeForAttempt({ finishedAt: 999 }, marker), undefined)
  // No backend state (desktop, or the app was restarted): fall back to the list.
  assert.equal(outcomeForAttempt(undefined, marker), undefined)
})

test('reopening the source dialog is wired on both ends of the reload', async () => {
  const dialog = await readFile(new URL('../src/features/recommendations/RecommendationSourceDialog.tsx', import.meta.url), 'utf8')
  // The login page replaces the app page, so the marker has to be written
  // before the command navigates away.
  const mark = dialog.indexOf('if (android) markWebLoginReturn(sourceIds)')
  assert.ok(mark > 0, 'NeteaseWebLogin must mark the login before navigating away')
  assert.ok(mark < dialog.indexOf('await webLoginNetease(true)'), 'the marker must be written before the login command runs')
  assert.match(dialog, /clearWebLoginReturn\(\)/, 'pages that keep their JavaScript must clear the marker')

  const view = await readFile(new URL('../src/features/recommendations/RecommendationView.tsx', import.meta.url), 'utf8')
  assert.match(view, /peekWebLoginReturn\(\)/)
  assert.match(view, /sourceAddedByLogin\(sourceList, loginReturn\)/)
  assert.match(view, /setSourceDialog\('list'\)/, 'the reload reopens the dialog the login started from')
  // A failed login has to say why: the command's rejection went to a document
  // that no longer exists, so the reloaded page reads the outcome instead.
  assert.match(view, /webLoginOutcome\(\)/)
  assert.match(view, /outcomeForAttempt\(outcome, loginReturn\)/)
  assert.match(view, /isNeteaseLoginCancelled\(outcome\.error\)/, 'a cancel is not an error')

  const service = await readFile(new URL('../src/services/recommendations.ts', import.meta.url), 'utf8')
  assert.match(service, /export async function webLoginOutcome\(/)
  assert.match(service, /'netease_web_login_outcome'/, 'the outcome is fetched from the backend')

  const app = await readFile(new URL('../src/app/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /peekWebLoginReturn\(\)/)
  assert.match(app, /openExploreDetail\('每日推荐'\)/, 'the reload returns to the recommendations page')
})
