import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const compiled = await build({ entryPoints: ['src/features/lyrics/biasWriter.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const { createBiasWriter, clampBias } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

test('rapid lyric adjustments coalesce and in-flight writes finish in order across tracks', async () => {
  const writes = []
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const writer = createBiasWriter(async (id, value) => { writes.push([id, value]); if (writes.length === 1) await barrier }, () => {}, 10000)
  writer.set('a', 500); writer.set('a', 1000)
  const first = writer.flush()
  assert.deepEqual(writes, [['a', 1000]])
  writer.set('a', 1500); writer.set('b', -500); writer.set('a', 2000)
  release(); await first; await writer.flush()
  assert.deepEqual(writes, [['a', 1000], ['a', 2000], ['b', -500]])
})

test('a failed save does not block the next adjustment, and account cancellation discards queued writes', async () => {
  const results = []
  let attempts = 0
  const writer = createBiasWriter(async () => { if (++attempts === 1) throw new Error('offline') }, (id, value, error) => results.push([id, value, Boolean(error)]), 10000)
  writer.set('a', 500); await writer.flush()
  writer.set('a', 1000); await writer.flush()
  writer.set('b', 2000); writer.cancel(); await writer.flush()
  assert.deepEqual(results, [['a', 500, true], ['a', 1000, false]])
  assert.equal(attempts, 2)
  assert.equal(clampBias(60000), 30000)
  assert.equal(clampBias(-60000), -30000)
})
