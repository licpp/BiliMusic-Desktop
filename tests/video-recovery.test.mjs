import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const output = await build({ entryPoints: ['src/features/lyrics/videoRecovery.ts'], bundle: true, write: false, format: 'esm' })
const { createVideoRecovery, createVideoRefreshScope } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
function setup(refresh = async () => {}) {
  const calls = [], errors = []
  return { calls, errors, recovery: createVideoRecovery({ refresh: () => { calls.push('refresh'); return refresh() }, restart: () => calls.push('restart'), busy: value => calls.push(value), failed: error => errors.push(error) }) }
}
test('refreshes before restarting, coalesces concurrent clicks and bounds automatic attempts', async () => {
  let done
  const { calls, recovery } = setup(() => new Promise(resolve => { done = resolve }))
  const first = recovery.recover(), duplicate = recovery.recover()
  assert.equal(first, duplicate)
  await Promise.resolve()
  assert.deepEqual(calls, [true, 'refresh'])
  done(); assert.equal(await first, true)
  assert.deepEqual(calls, [true, 'refresh', 'restart', false])
  const second = recovery.recover(); await Promise.resolve(); done(); await second
  assert.equal(await recovery.recover(), false)
  assert.equal(calls.filter(value => value === 'refresh').length, 2)
  const manual = recovery.recover(true); await Promise.resolve(); done(); await manual
  assert.equal(calls.filter(value => value === 'restart').length, 3)
})
test('unmounting during a refresh cannot restart the next song or write stale errors', async () => {
  let reject
  const { calls, errors, recovery } = setup(() => new Promise((_, fail) => { reject = fail }))
  const pending = recovery.recover(); await Promise.resolve(); recovery.dispose(); reject(Error('offline'))
  assert.equal(await pending, false)
  assert.deepEqual(calls, [true, 'refresh'])
  assert.deepEqual(errors, [])
  assert.equal(await recovery.recover(true), false)
})
test('failed refresh remains retryable; sustained healthy playback replenishes the budget', async () => {
  let fail = true
  const { calls, errors, recovery } = setup(async () => { if (fail) throw Error('offline') })
  assert.equal(await recovery.recover(), false)
  assert.match(errors[0].message, /offline/)
  fail = false
  assert.equal(await recovery.recover(), true)
  assert.equal(await recovery.recover(), false)
  recovery.healthy()
  assert.equal(await recovery.recover(), true)
  assert.equal(calls.filter(value => value === 'restart').length, 2)
})

test('a disposed or superseded source refresh cannot restart the video', async () => {
  const disposed = setup()
  const pending = disposed.recovery.recover()
  disposed.recovery.dispose()
  assert.equal(await pending, false)
  assert.deepEqual(disposed.calls, [true])

  const stale = setup(async () => false)
  assert.equal(await stale.recovery.recover(), false)
  assert.deepEqual(stale.calls, [true, 'refresh', false])
  assert.deepEqual(stale.errors, [])
})

test('an old track refresh loses ownership after an A → B → A playback transition', async () => {
  const source = createVideoRefreshScope()
  source.activate()
  let playback = 1
  const current = () => playback === 1
  const deferred = Promise.withResolvers()
  const writes = []
  const pending = source.refresh(current, () => deferred.promise, value => writes.push(value))
  playback += 2
  deferred.resolve('original A source')
  assert.equal(await pending, false)
  assert.deepEqual(writes, [])
})

test('reopening the same cover/video view protects its source and ready frame from the old view', async () => {
  const oldView = createVideoRefreshScope()
  const closeOldView = oldView.activate()
  const deferred = Promise.withResolvers()
  let url = 'cached', readyFrame = 'cached'
  const commit = value => { url = value; readyFrame = undefined }
  const current = () => true
  const pending = oldView.refresh(current, () => deferred.promise, commit)

  closeOldView()
  const reopened = createVideoRefreshScope()
  reopened.activate()
  assert.equal(await oldView.refresh(current, () => assert.fail('Unmounted views must not load a source'), commit), false)
  assert.equal(await reopened.refresh(current, async () => 'reopened source', commit), true)
  readyFrame = url
  deferred.resolve('old view source')
  assert.equal(await pending, false)
  assert.equal(url, 'reopened source')
  assert.equal(readyFrame, url)
})

test('only the latest refresh of an active view can commit or surface a failure', async () => {
  const scope = createVideoRefreshScope()
  scope.activate()
  const deferred = Promise.withResolvers()
  const current = () => true
  const commit = () => assert.fail('A failed refresh must not write the source')
  const old = scope.refresh(current, () => deferred.promise, commit)
  await assert.rejects(scope.refresh(current, async () => { throw Error('current failure') }, commit), /current failure/)
  deferred.reject(Error('old failure'))
  assert.equal(await old, false)
})
