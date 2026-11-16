import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const compiled = await build({
  stdin: { contents: "export * from './src/features/lyrics/automaticLyrics'; export { firstSongQuery } from './src/domain/songIdentity'", resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'lyrics-boundary', setup(builder) {
    builder.onResolve({ filter: /services\/desktopApi$/ }, () => ({ path: 'api', namespace: 'mock' }))
    builder.onResolve({ filter: /player\/playerStore$/ }, () => ({ path: 'store', namespace: 'mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'api' ? `
      export const inDesktopShell = true;
      export const getStoredLyrics = async () => ++globalThis.autoTest.reads > 1 && !globalThis.autoTest.allowSave ? { selectedManually: true } : null;
      export const searchLyrics = async (title, artist) => {
        globalThis.autoTest.queries?.push({title,artist});
        if (globalThis.autoTest.failFirst && globalThis.autoTest.queries.length === 1) throw new Error('temporary failure');
        return { candidates: [globalThis.autoTest.candidate] };
      };
      export const saveStoredLyrics = async () => { globalThis.autoTest.writes++; return { saved: true }; };
    ` : `export const usePlayerStore = { getState: () => globalThis.autoTest.state, subscribe: () => () => {} };` }))
  } }],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { firstSongQuery, chooseAutomaticLyrics, startAutomaticLyrics } = module.exports
const track = { id: 'test', title: '001.田馥甄-小幸运', durationSeconds: 260 }
const candidate = { provider: 'lrclib', id: 1, trackName: '小幸运', artistName: '田馥甄', duration: 260, syncedLyrics: '[00:01.00]test' }

test('automatic lyrics clean Bilibili part titles and reject unrelated songs, artists and versions', () => {
  assert.deepEqual(firstSongQuery(track), { title: '小幸运', artist: '田馥甄' })
  assert.equal(chooseAutomaticLyrics(track, [candidate]), candidate)
  for (const patch of [{ trackName: '其他歌曲' }, { artistName: '其他歌手' }, { duration: 600 }, { instrumental: true }]) {
    assert.equal(chooseAutomaticLyrics(track, [{ ...candidate, ...patch }]), undefined)
  }
})

test('a manual selection made during automatic lookup is preserved', async () => {
  globalThis.autoTest = { state: { current: track, status: 'playing' }, candidate, reads: 0, writes: 0 }
  const stop = startAutomaticLyrics()
  try {
    await new Promise(resolve => setTimeout(resolve, 700))
    assert.equal(autoTest.reads, 2)
    assert.equal(autoTest.writes, 0)
  } finally { stop() }
})

test('noisy video captions match the extracted song and singer, not the uploader', () => {
  for (const [title, uploader, song, singer] of [
    ['在百万豪装录音棚听王菲《红豆》', 'JLRS-LeoFM', '红豆', '王菲'],
    ['【私藏馆】孙燕姿 《遇见》 爆火神曲！祝大家节日快乐', '音乐私藏馆', '遇见', '孙燕姿'],
  ]) {
    const video = { ...track, title, artist: uploader, source: { uploaderName: uploader } }
    const correct = { ...candidate, trackName: song, artistName: singer }
    const wrongSinger = { ...correct, artistName: '其他歌手' }
    assert.equal(chooseAutomaticLyrics(video, [wrongSinger, correct]), correct)
    assert.equal(chooseAutomaticLyrics(video, [wrongSinger]), undefined)
    assert.equal(chooseAutomaticLyrics(video, [{ ...correct, duration: 600 }]), undefined)
    assert.equal(chooseAutomaticLyrics(video, [{ ...correct, trackName: song + ' (Live)' }]), undefined)
  }
})

test('version and medley boundaries survive title extraction', () => {
  const original = { ...candidate, trackName: '红豆', artistName: '王菲' }
  const live = { ...original, trackName: '红豆 (Live)' }
  const video = { ...track, title: '王菲《红豆》（现场版）' }
  assert.equal(chooseAutomaticLyrics(video, [original]), undefined)
  assert.equal(chooseAutomaticLyrics(video, [original, live]), live)
  assert.equal(chooseAutomaticLyrics({ ...video, title: '王菲《红豆》《流年》连唱' }, [original]), undefined)
  assert.equal(chooseAutomaticLyrics({ ...video, title: '王菲《红豆》' }, [{ ...original, syncedLyrics: '[00:01.00]', plainLyrics: '' }]), undefined)
})

async function automaticLookup(video, found, extra = {}) {
  globalThis.autoTest = { state: { current: video, status: 'playing' }, candidate: found, reads: 0, writes: 0, queries: [], allowSave: true, ...extra }
  const previousWindow = globalThis.window
  globalThis.window = { dispatchEvent() {} }
  const stop = startAutomaticLyrics()
  try { await new Promise(resolve => setTimeout(resolve, 700)); return globalThis.autoTest }
  finally { stop(); globalThis.window = previousWindow }
}

test('automatic lookup searches the extracted metadata and saves once', async () => {
  const result = await automaticLookup(
    { ...track, title: '在百万豪装录音棚听王菲《红豆》', artist: 'JLRS-LeoFM', source: { uploaderName: 'JLRS-LeoFM' } },
    { ...candidate, trackName: '红豆', artistName: '王菲' },
  )
  assert.deepEqual(result.queries, [{ title: '红豆', artist: '王菲' }])
  assert.equal(result.writes, 1)
})

test('one failed orientation can try the other without accepting unrelated metadata', async () => {
  const result = await automaticLookup(
    { ...track, title: '田馥甄 - 小幸运' }, candidate, { failFirst: true },
  )
  assert.deepEqual(result.queries, [{ title: '田馥甄', artist: '小幸运' }, { title: '小幸运', artist: '田馥甄' }])
  assert.equal(result.writes, 1)
})

test('shared edition aliases improve recognition without relaxing automatic lyric identity',()=>{
  for (const edition of ['Live','Cover','Remastered','Acoustic','Remix','Sped Up','Slowed','Orchestral']) {
    const video={...track,title:`王菲《红豆》 (${edition})`}
    const correct={...candidate,trackName:`红豆 (${edition})`,artistName:'王菲'}
    assert.equal(chooseAutomaticLyrics(video,[{...correct,trackName:'红豆'},correct]),correct)
    assert.equal(chooseAutomaticLyrics({...video,title:'王菲《红豆》'},[correct]),undefined)
    assert.equal(chooseAutomaticLyrics(video,[{...correct,artistName:'其他歌手'}]),undefined)
    assert.equal(chooseAutomaticLyrics(video,[{...correct,duration:600}]),undefined)
  }
  const video={...track,title:'王菲《红豆 (Live)》翻唱'}
  const both={...candidate,trackName:'红豆 (Live) (Cover)',artistName:'王菲'}
  assert.equal(chooseAutomaticLyrics(video,[{...both,trackName:'红豆 (Live)'},both]),both)
})
