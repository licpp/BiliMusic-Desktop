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

test('the pinned 三言二拍 directory links fullwidth timecodes and keeps their original characters', () => {
  const message = '1.牧童奇梦00：13，2.客舫奇遇06：57，3.转运汉14：04，4.张廷秀20：53，5.炼金术31：19，6.错占凤凰39：21，7.小棋士 49：27\t，8.玉马坠 56：47\t，9.一言得妻1：07：38'
  const segments = commentTimeline(message, 17838)
  assert.equal(segments.map(part => part.text).join(''), message)
  assert.deepEqual(segments.filter(part => part.timestamp !== undefined), [
    { text: '00：13', timestamp: 13 }, { text: '06：57', timestamp: 417 }, { text: '14：04', timestamp: 844 },
    { text: '20：53', timestamp: 1253 }, { text: '31：19', timestamp: 1879 }, { text: '39：21', timestamp: 2361 },
    { text: '49：27', timestamp: 2967 }, { text: '56：47', timestamp: 3407 }, { text: '1：07：38', timestamp: 4058 },
  ])
})

test('URLs, malformed values and times outside the current part remain ordinary text', () => {
  const message = 'https://example.test/watch?at=0:02 https://example.test/watch?at=０：０３ 1:79 ０：００：００：０１ 1:00 ０：５９'
  assert.deepEqual(timestampValues(commentTimeline(message, 60)), [59])
  assert.equal(commentTimeline(message, 0)[0].text, message)
})
