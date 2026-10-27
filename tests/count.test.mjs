import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const result = await build({ entryPoints: ['src/shared/count.ts'], bundle: true, write: false, format: 'esm' })
const { formatPlayCount } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
test('play counts use compact Chinese units at the correct boundaries', () => {
  assert.equal(formatPlayCount(9999), '9,999')
  assert.equal(formatPlayCount(10000), '1万')
  assert.equal(formatPlayCount(12500), '1.3万')
  assert.equal(formatPlayCount(1834356), '183.4万')
  assert.equal(formatPlayCount(100000000), '1亿')
  assert.equal(formatPlayCount(NaN), '0')
})
