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
