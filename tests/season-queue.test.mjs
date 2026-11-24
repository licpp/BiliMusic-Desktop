import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['src/features/player/queueGroups.ts'], bundle: true, write: false, format: 'esm',
})
const { presentQueue } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const part = (bvid, page, resolveParts = false) => ({ id: `${bvid}:${page}`, source: { provider: 'bilibili', bvid, page }, resolveParts })

test('standalone videos list parts directly and season groups contain only multiple playable rows', () => {
  const parts = [part('B', 1), part('B', 2)]
  assert.equal(presentQueue(parts, 'video').partsOnly, true)
  assert.deepEqual(presentQueue(parts, 'video').groups.map(group => group.tracks.length), [1, 1])
  assert.deepEqual(presentQueue([part('A', 1), part('C', 1, true), ...parts], 'season').groups.map(group => group.tracks.length), [1, 1, 2])
  assert.deepEqual(presentQueue(parts).groups.map(group => group.tracks.length), [1, 1])
})

test('queue group identity follows its tracks when runs and parts move', () => {
  const first = [part('B', 1), part('B', 2)]
  const second = [part('B', 3), part('B', 4)]
  const separator = part('A', 1)
  const keys = tracks => presentQueue(tracks, 'season').groups.map(group => group.key)
  const [firstKey, separatorKey, secondKey] = keys([...first, separator, ...second])
  assert.notEqual(firstKey, secondKey)
  assert.deepEqual(keys([...second, separator, first[1], first[0]]), [secondKey, separatorKey, firstKey])
})
