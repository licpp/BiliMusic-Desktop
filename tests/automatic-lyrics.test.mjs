import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const compiled = await build({
  entryPoints: ['src/features/lyrics/automaticLyrics.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'lyrics-boundary', setup(builder) {
    builder.onResolve({ filter: /services\/desktopApi$/ }, () => ({ path: 'api', namespace: 'mock' }))
    builder.onResolve({ filter: /player\/playerStore$/ }, () => ({ path: 'store', namespace: 'mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'api' ? `
      export const inDesktopShell = true;
      export const getStoredLyrics = async () => ++globalThis.autoTest.reads > 1 ? { selectedManually: true } : null;
      export const searchLyrics = async () => ({ candidates: [globalThis.autoTest.candidate] });
      export const saveStoredLyrics = async () => { globalThis.autoTest.writes++; };
    ` : `export const usePlayerStore = { getState: () => globalThis.autoTest.state, subscribe: () => () => {} };` }))
  } }],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { automaticLyricQuery, chooseAutomaticLyrics, startAutomaticLyrics } = module.exports
const track = { id: 'test', title: '001.田馥甄-小幸运', durationSeconds: 260 }
const candidate = { provider: 'lrclib', id: 1, trackName: '小幸运', artistName: '田馥甄', duration: 260, syncedLyrics: '[00:01.00]test' }

test('automatic lyrics clean Bilibili part titles and reject unrelated songs, artists and versions', () => {
  assert.deepEqual(automaticLyricQuery(track), { title: '小幸运', artist: '田馥甄' })
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
