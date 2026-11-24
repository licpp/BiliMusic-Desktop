import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/domain/playbackChapters.ts'], bundle: true, write: false, format: 'esm' })
const { chapterIndexAt, chaptersWithinDuration } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

test('the current chapter honors official ends, gaps and the next exact start', () => {
  const chapters = [{ startMs: 1000, endMs: 4000, title: '引言' }, { startMs: 6000, title: '正文' }]
  assert.deepEqual([0, 1000, 3999, 4000, 5999, 6000, 12000].map(t => chapterIndexAt(chapters, t)), [-1, 0, 0, -1, -1, 1, 1])
})

test('nearby chapters remain distinct in previews and in the directory', () => {
  const chapters = [
    { startMs: 0, endMs: 5000, title: '开场' },
    { startMs: 5000, title: '上篇' },
    { startMs: 5100, endMs: 20000, title: '插曲' },
    { startMs: 20000, title: '下篇' },
  ]
  assert.equal(chapters[chapterIndexAt(chapters, 5050)].title, '上篇')
  assert.equal(chapters[chapterIndexAt(chapters, 5100)].title, '插曲')
  assert.deepEqual(chaptersWithinDuration(chapters, 20), chapters.slice(0, 3))
  assert.deepEqual(chaptersWithinDuration(chapters, 0), chapters)
})
