import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({ entryPoints: ['src/shared/time.ts'], write: false, format: 'esm' })
const { formatDuration, formatTrackDuration } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)

test('long playback shows hours while unavailable track duration is distinguished from zero progress', () => {
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(3599.9), '59:59')
  assert.equal(formatDuration(3600), '1:00:00')
  assert.equal(formatDuration(7261), '2:01:01')
  assert.equal(formatDuration(64, true), '0:01:04')
  assert.equal(formatTrackDuration(0), '—')
  assert.equal(formatTrackDuration(7261), '2:01:01')
})
