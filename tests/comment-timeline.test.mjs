import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ entryPoints: ['src/domain/commentTimeline.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const { commentTimeline } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const timestampValues = segments => segments.filter(part => part.timestamp !== undefined).map(part => part.timestamp)

test('comment timecodes retain original text and support minutes, hours and Chinese punctuation', () => {
  const message = '0:00，精彩在 3:15。\n最后 1:10:42 再见'
  const segments = commentTimeline(message, 5000)
  assert.equal(segments.map(part => part.text).join(''), message)
  assert.deepEqual(timestampValues(segments), [0, 195, 4242])
})

test('URLs, malformed values and times outside the current part remain ordinary text', () => {
  const message = 'https://example.test/watch?at=0:02 1:79 0:00:00:01 1:00 0:59'
  assert.deepEqual(timestampValues(commentTimeline(message, 60)), [59])
  assert.equal(commentTimeline(message, 0)[0].text, message)
})
