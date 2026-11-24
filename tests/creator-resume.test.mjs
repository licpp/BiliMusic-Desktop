import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['src/features/collections/creatorContinuation.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'continuation-ports', setup(builder) {
    builder.onResolve({ filter: /desktopApi$/ }, () => ({ path: 'desktop', namespace: 'fixture' }))
    builder.onResolve({ filter: /playerStore$/ }, () => ({ path: 'player', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      desktop: 'export const getVideoParts = bvid => globalThis.creatorContinuationTest.getVideoParts(bvid)',
      player: `import { replaceSeasonEntry } from './src/features/player/seasonQueue';
      export const playbackIntent = () => globalThis.creatorContinuationTest.intent;
      export const seasonPlaybackQueue = (queue, selected, parts) => replaceSeasonEntry(queue, queue.find(track => track.source.bvid === selected.source.bvid)?.id, parts);
      export const usePlayerStore = {getState: () => ({playFromList: (...args) => globalThis.creatorContinuationTest.plays.push(args)})};`,
    }[path], resolveDir: process.cwd() }))
  } }],
})
const { createCollectionResume, isCurrentCollectionResume, resolveCreatorContinuation, resumeCreatorUploads } =
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)

const creator = { bvid: 'up:9527', title: '深夜电台', coverUrl: '', folderId: '', uploaderName: '深夜电台' }
const point = { bvid: 'BV1ZZ411x7hA', cid: 23, positionMs: 181500 }
const summary = { id:19, uploaderId:9527, uploaderName: creator.title, coverUrl:'', title: '周末现场' }
const detail = { bvid: point.bvid, aid: 3, uploaderId: 9527, uploaderName: creator.title, title: '现场录音', coverUrl:'',
  parts: [{ cid: 22, page: 1, title: '导言', durationSeconds: 10 }, { cid: 23, page: 2, title: '现场录音', durationSeconds: 400 }] }
const fixture = (getVideoParts = async () => detail) => globalThis.creatorContinuationTest = { getVideoParts, plays: [], intent: 1 }

test('a saved season origin wins over a video’s other season and requires no B station lookup', async () => {
  fixture(() => { throw Error('unexpected video request') })
  const result = await resolveCreatorContinuation({ ...point, collectionRef: 'season:9527:20' }, creator, () => true)
  assert.equal(result.collection.bvid, 'season:9527:20')
})

test('a legacy creator checkpoint opens its known season and skips another uploader’s season', async () => {
  const f = fixture(async () => ({ ...detail, season:summary }))
  assert.equal((await resolveCreatorContinuation(point, creator, () => true)).collection.bvid, 'season:9527:19')
  f.getVideoParts = async () => ({ ...detail, season: { ...summary, uploaderId: 1 } })
  assert.equal((await resolveCreatorContinuation(point, creator, () => true)).detail.bvid, point.bvid)
})

test('a new playback intent invalidates a pending creator lookup', async () => {
  let respond
  const f = fixture(() => new Promise(resolve => { respond = resolve }))
  const request = createCollectionResume(point)
  const pending = resolveCreatorContinuation(point, creator, () => isCurrentCollectionResume(request))
  f.intent++
  respond({ ...detail, season: summary })
  assert.equal(await pending, undefined)
})

test('a creator checkpoint without a season resumes at the exact part in the uploads queue', async () => {
  const f = fixture()
  const upload = (bvid, aid) => ({ bvid, aid, pic:'', title: bvid, length: '07:30' })
  const first = { page: 1, data: { page: { count: 32 }, list: { vlist: [upload('BV1ZZ411x7hB', 2)] } } }
  const second = { page: 2, data: { page: { count: 32 }, list: { vlist: [upload(point.bvid, 3)] } } }
  await resumeCreatorUploads(creator, point, detail, () => true, async page => { assert.equal(page, 2); return second }, [first])
  const [queue, id, source, seconds, explicit] = f.plays[0]
  assert.equal(queue[0].source.bvid, 'BV1ZZ411x7hB')
  assert.equal(queue[2].source.cid, 23)
  assert.equal(id, `bilibili:${point.bvid}:23`)
  assert.equal(source.creatorPage, 2)
  assert.equal(source.collectionRef, creator.bvid)
  assert.equal(seconds, 181.5)
  assert.equal(explicit, true)
})
