import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query')

const boundaries = new Map([
  ['playerStore', 'export const usePlayerStore = selector => selector(globalThis.miniPlayback)'],
  ['desktopApi', 'export const inDesktopShell = true; export const getStoredLyrics = async () => null; export const commandErrorMessage = String'],
  ['immersiveWindow', 'export const setMiniPlayerPanel = async () => {}'],
  ['mediaSources', 'export const getSubtitles = async () => []; export const getSubtitleLines = async () => []'],
])

const output = await build({
  stdin: {
    contents: `export { MiniPlayer } from './src/features/player/MiniPlayer';
      export { subtitleScope, useSubtitleState } from './src/features/lyrics/useBiliSubtitles';
      export { accountQueryKey } from './src/services/queryKeys';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', '@tanstack/react-query', 'zustand'],
  plugins: [{ name: 'mini-player-boundaries', setup(builder) {
    builder.onResolve({ filter: /\/(playerStore|desktopApi|immersiveWindow|mediaSources)$/ }, ({ path }) => ({
      path: path.split('/').at(-1), namespace: 'fixture',
    }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: boundaries.get(path) }))
  } }],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports)
const { MiniPlayer, subtitleScope, useSubtitleState, accountQueryKey } = module.exports
const emptySubtitles = { ...useSubtitleState.getInitialState() }

const track = { id: 'bilibili:BVfixture:1', title: '测试歌曲', artist: '', source: { provider: 'bilibili', bvid: 'BVfixture', cid: 1 } }
const captions = {
  active: true,
  scope: subtitleScope(track.source),
  lines: [{ timeMs: 1000, endTimeMs: 2200, text: '第一句字幕' }, { timeMs: 2500, text: '第二句字幕' }],
}
const saved = { rawText: '[00:01.00]第一句歌词\n[00:02.50]第二句歌词', biasMs: 1500 }

function renderLyric({ current = track, position = 3, subtitles, matchedLyrics } = {}) {
  globalThis.miniPlayback = { current, progressSeconds: position, durationSeconds: 30, volume: 1, status: 'paused' }
  // React's server renderer reads Zustand's initial snapshot.
  Object.assign(useSubtitleState.getInitialState(), emptySubtitles, subtitles)
  const client = new QueryClient()
  if (matchedLyrics) client.setQueryData(accountQueryKey('mini-lyrics', current.id), matchedLyrics)
  const noop = () => {}
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MiniPlayer, {
    busy: false, onRestore: noop, onFavorite: noop, favoritePending: false, onError: noop,
  })))
  return html.match(/class="mini-marquee(?: scrolling)?" title="([^"]+)"/)?.[1]
}

test('the mini player shows active AI subtitles without requiring locally matched lyrics', () => {
  assert.equal(renderLyric({ subtitles: captions, position: 1.1 }), '第一句字幕')
  assert.equal(renderLyric({ subtitles: captions, position: 3 }), '第二句字幕')
  assert.equal(renderLyric({ subtitles: captions, matchedLyrics: saved }), '第二句字幕')
})

test('inactive or stale subtitles leave the mini player on matched lyrics and their saved offset', () => {
  const otherTrack = { ...track, id: 'bilibili:BVfixture:2', source: { ...track.source, cid: 2 } }
  assert.equal(renderLyric({ current: otherTrack, subtitles: captions }), '歌手未知')
  assert.equal(renderLyric({ subtitles: { ...captions, scope: subtitleScope(track.source, 1) } }), '歌手未知')
  assert.equal(renderLyric({ subtitles: { ...captions, active: false }, matchedLyrics: saved }), '第一句歌词')
  assert.equal(renderLyric({ subtitles: { ...captions, lines: undefined }, matchedLyrics: saved }), '第一句歌词')
})
