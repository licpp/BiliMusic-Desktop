import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import {importEntryCommand} from './fixtures/import-entry-store.mjs'

const { outputFiles } = await build({
  entryPoints: ['src/services/playlistImport.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'import-boundaries', setup(b) {
    b.onResolve({ filter: /^\.\/desktopApi$/ }, () => ({ path: 'api', namespace: 'mock' }))
    b.onResolve({ filter: /^\.\/accountScope$/ }, () => ({ path: 'scope', namespace: 'mock' }))
    b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'mock' }))
    b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents: path === 'api'
      ? 'export const inDesktopShell=true;export const searchBilibili=(...args)=>window.fixture.search(...args);export const getVideoParts=(...args)=>window.fixture.detail(...args);export const listPlaylistTracks=async()=>[];export const commandErrorMessage=e=>e.message||String(e)'
      : path === 'scope' ? 'export const accountEpoch=()=>1'
      : 'export const invoke=(...args)=>window.fixture.invoke(...args)' }))
  } }],
})
const valid = 'BV1GJ411x7h7', other = 'BV1Wr4218772'
const song = { sourceId: 'text:1', title: '晴天', artists: ['周杰伦'], durationSeconds: 269 }
const item = (bvid, title = '周杰伦《晴天》') => ({ bvid, title, uploaderName: '音乐', durationSeconds: 269 })
const detail = (bvid, title = '周杰伦《晴天》') => ({ bvid, title, uploaderName: '音乐', uploaderId: 1, coverUrl: '', parts: [{ cid: 1, page: 1, title, durationSeconds: 269, coverUrl: '' }] })
function setup(search, read = async bvid => detail(bvid)) {
  const window = new EventTarget(), requests = [], commits = [], state={scope:'account:1',commits:[]}
  window.fixture = { search: async keyword => ({ items: await search(keyword) }), detail: async bvid => { requests.push(bvid); return read(bvid) }, invoke: async (command, args) => {
    state.commits=commits;const result=importEntryCommand(state,command,args);if(result!==undefined)return result;
    if (command === 'playlist_import_commit') { commits.push(args); return { id: args.playlistId, name: args.name } }
    return undefined
  } }
  let now = Date.now()
  class Clock extends Date { static now() { return now += 20_000 } }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'window', 'Date', outputFiles[0].text)(createRequire(import.meta.url), module, module.exports, window, Clock)
  return { ...module.exports, requests, commits }
}
test('malformed search identifiers do not consume the detail candidate budget', async () => {
  const a = setup(async () => ['', 'av123', 'bv1GJ411x7h7', 'https://b23.tv/test', valid].map(bvid => item(bvid)))
  const choices = await a.findImportCandidates(song, new AbortController().signal)
  assert.deepEqual(a.requests, [valid]); assert.equal(choices[0].track.source.bvid, valid)
})
test('a rejected BV candidate is skipped and another valid match can be imported', async () => {
  const a = setup(async () => [item(valid), item(other)], async bvid => {
    if (bvid === valid) throw { code: 'validation', message: '无效的 BV 号' }
    return detail(bvid)
  })
  assert.equal((await a.findImportCandidates(song, new AbortController().signal))[0].track.source.bvid, other)
  assert.deepEqual(a.requests, [valid, other])
})
test('malformed-only results leave one row unmatched without stopping the following rows', async () => {
  const a = setup(async keyword => keyword.includes('晴天') ? [item('')] : [item(valid, '王菲《红豆》')], async bvid => detail(bvid, '王菲《红豆》'))
  a.usePlaylistImport.setState({ scope: 'account:1', job: null })
  a.newPlaylistImport({ name: '列表', source: 'text', songs: [song, { ...song, sourceId: 'text:2', title: '红豆', artists: ['王菲'] }] }, '列表')
  await a.runPlaylistImport()
  const job = a.usePlaylistImport.getState().job
  assert.equal(job.state, 'done'); assert.deepEqual(job.rows.map(row => row.status), ['missing', 'saved'])
  assert.equal(a.commits.length, 1); assert.equal(a.commits[0].entries[0].originalPosition, 1)
})
test('network and rate-limit errors still propagate instead of being treated as missing songs', async () => {
  for (const error of [new Error('network offline'), { code: 'bili_rate_limited', message: 'B站限制搜索' }]) {
    const a = setup(async () => [item(valid)], async () => { throw error })
    await assert.rejects(a.findImportCandidates(song, new AbortController().signal), value => value === error)
  }
})
test('a mismatched detail response or invalid part identity cannot become an imported track', async () => {
  for (const response of [detail(other), { ...detail(valid), parts: [{ cid: 0, title: '晴天' }] }]) {
    const a = setup(async () => [item(valid)], async () => response)
    assert.deepEqual(await a.findImportCandidates(song, new AbortController().signal), [])
  }
})
