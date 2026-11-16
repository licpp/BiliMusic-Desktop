import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const output = await build({ entryPoints: ['src/features/lyrics/videoRecovery.ts'], bundle: true, write: false, format: 'esm' })
const { createVideoRecovery } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
function setup(refresh = async () => {}) {
  const calls = [], errors = []
  return { calls, errors, recovery: createVideoRecovery({ refresh: async () => { calls.push('refresh'); await refresh() }, restart: () => calls.push('restart'), busy: value => calls.push(value), failed: error => errors.push(error) }) }
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
