import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const compiled = await build({
  stdin: { contents: "export * from './src/features/lyrics/biasWriter.ts'; export { LyricBiasConflict } from './src/domain/lyrics.ts'", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
})
const { createBiasWriter, clampBias, LyricBiasConflict } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const selection = (trackId, writeToken = trackId, biasMs = 0) => ({ trackId, writeToken, biasMs, accountSession: 'account' })

test('rapid lyric adjustments coalesce and in-flight writes finish in order across tracks', async () => {
  const writes = []
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const writer = createBiasWriter(async (expected, value) => {
    writes.push([expected.trackId, expected.biasMs, value])
    if (writes.length === 1) await barrier
    return { ...expected, biasMs: value }
  }, () => {}, 10000)
  writer.set(selection('a'), 500); writer.set(selection('a', 'a', 500), 1000)
  const first = writer.flush()
  assert.deepEqual(writes, [['a', 0, 1000]])
  writer.set(selection('a', 'a', 1000), 1500); writer.set(selection('b'), -500); writer.set(selection('a', 'a', 1500), 2000)
  release(); await first; await writer.flush()
  assert.deepEqual(writes, [['a', 0, 1000], ['a', 1000, 2000], ['b', 0, -500]])
})

test('a failed save does not block the next adjustment, and account cancellation discards queued writes', async () => {
  const results = []
  let attempts = 0
  const writer = createBiasWriter(async (expected, biasMs) => {
    if (++attempts === 1) throw new Error('offline')
    return { ...expected, biasMs }
  }, (expected, value, error) => results.push([expected.trackId, value, Boolean(error)]), 10000)
  writer.set(selection('a'), 500); await writer.flush()
  writer.set(selection('a'), 1000); await writer.flush()
  writer.set(selection('b'), 2000); writer.cancel(); await writer.flush()
  assert.deepEqual(results, [['a', 500, true], ['a', 1000, false]])
  assert.equal(attempts, 2)
  assert.equal(clampBias(60000), 30000)
  assert.equal(clampBias(-60000), -30000)
})

test('delayed offsets keep their original lyric selection when the same song is rematched', async () => {
  let persisted = selection('a', 'old')
  const attempted = []
  const writer = createBiasWriter(async (expected, biasMs) => {
    attempted.push(expected.writeToken)
    if (expected.writeToken !== persisted.writeToken) throw new Error('selection changed')
    persisted = { ...persisted, biasMs }
    return persisted
  }, () => {}, 10000)

  writer.set(persisted, 1000)
  persisted = selection('a', 'new')
  await writer.flush()
  assert.equal(persisted.biasMs, 0)

  writer.set(persisted, 500)
  await writer.flush()
  assert.deepEqual(attempted, ['old', 'new'])
  assert.equal(persisted.biasMs, 500)
})

test('a synchronized bias replaces the stale UI base and the next adjustment saves', async () => {
  let displayed = selection('a')
  let persisted = selection('a', 'a', 900)
  const writes = []
  let release
  const firstSave = new Promise(resolve => { release = resolve })
  const writer = createBiasWriter(async (expected, biasMs) => {
    writes.push([expected.biasMs, biasMs])
    if (writes.length === 1) await firstSave
    if (expected.biasMs !== persisted.biasMs) throw new LyricBiasConflict(persisted)
    return persisted = { ...persisted, biasMs }
  }, (_, biasMs, error) => {
    assert.equal(displayed.biasMs, biasMs)
    if (error instanceof LyricBiasConflict) displayed = error.lyrics
  }, 10000)

  function adjust(delta) {
    const expected = displayed
    const next = displayed = { ...expected, biasMs: expected.biasMs + delta }
    writer.set(expected, next.biasMs, () => displayed === next)
  }
  adjust(500)
  const flushing = writer.flush()
  adjust(250)
  release()
  await flushing
  assert.equal(displayed.biasMs, 900)
  assert.deepEqual(writes, [[0, 500]])
  adjust(250)
  await writer.flush()
  assert.deepEqual(writes, [[0, 500], [900, 1150]])
  assert.equal(persisted.biasMs, 1150)
})

test('an older conflicting write leaves a newer operation on the synchronized base queued', async () => {
  const stale = selection('a')
  const synced = selection('a', 'a', 900)
  let release
  const firstSave = new Promise(resolve => { release = resolve })
  const writes = []
  const writer = createBiasWriter(async (expected, biasMs) => {
    writes.push([expected.biasMs, biasMs])
    if (expected === stale) {
      await firstSave
      throw new LyricBiasConflict(synced)
    }
    return { ...expected, biasMs }
  }, (_, __, error) => assert.equal(error, undefined), 10000)
  writer.set(stale, 500, () => false)
  const flushing = writer.flush()
  writer.set(synced, 1150)
  release()
  await flushing
  assert.deepEqual(writes, [[0, 500], [900, 1150]])
})
