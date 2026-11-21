import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['src/features/downloads/downloadSelection.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'download-dependencies', setup(build) {
    build.onResolve({ filter: /services\/(accountScope|desktopApi|contentVisibility|collectionTrack)$/ }, args => ({
      path: args.path.split('/').at(-1), namespace: 'fixtures',
    }))
    build.onLoad({ filter: /.*/, namespace: 'fixtures' }, ({ path }) => ({ contents: ({
      accountScope: 'export const accountEpoch = () => globalThis.downloadFixture.epoch;',
      desktopApi: 'export const getVideoParts = id => globalThis.downloadFixture.read(id);',
      contentVisibility: 'export const ensureVisibility = async () => {}; export const useContentVisibility = { getState: () => globalThis.downloadFixture };',
      collectionTrack: 'export const toTrack = (video, part) => ({ id: video.bvid + ":" + part.cid, title: "part", source: { provider: "bilibili", bvid: video.bvid, cid: part.cid } });',
    })[path] }))
  } }],
})
const { prepareDownloadSelection } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const row = (bvid, cid = 0) => ({ id: `${bvid}:${cid}`, title: bvid, resolveParts: !cid, source: { bvid, cid, provider: 'bilibili' } })
const video = (bvid, ...parts) => ({ bvid, parts: parts.map(cid => ({ cid })) })

test('downloading several videos skips hidden parts and hidden collection rows', async () => {
  const requested = []
  globalThis.downloadFixture = {
    epoch: 0,
    rules: [{ scope: 'video:BV1', target: 'cid:2', hidden: true },
      { scope: 'season:10:20', target: 'BV2', hidden: true },
      { scope: 'video:BV3', target: 'cid:8', hidden: true }],
    read: async id => { requested.push(id); return video(id, 1, 2, 3) },
  }
  const result = await prepareDownloadSelection([row('BV1'), row('BV2'), row('BV3', 8)], 'season:10:20')
  assert.deepEqual(requested, ['BV1'])
  assert.deepEqual(result.tracks.map(track => track.id), ['BV1:1', 'BV1:3'])
  assert.equal(result.failed, 0)
})

test('a late expansion uses current visibility and is discarded after an account switch', async () => {
  const rules = []
  globalThis.downloadFixture = {
    epoch: 0, rules,
    read: async id => {
      globalThis.downloadFixture.rules = [{ scope: 'video:BV1', target: 'cid:2', hidden: true }]
      return video(id, 1, 2)
    },
  }
  const result = await prepareDownloadSelection([row('BV1')])
  assert.deepEqual(result.tracks.map(track => track.id), ['BV1:1'])
  globalThis.downloadFixture.read = async id => {
    globalThis.downloadFixture.epoch++
    return video(id, 1)
  }
  assert.equal(await prepareDownloadSelection([row('BV1')]), undefined)
})
