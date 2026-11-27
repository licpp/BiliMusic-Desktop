import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = new Map([
  ['@tanstack/react-query', 'export const useQuery = fixture.useQuery'],
  ['../../services/desktopApi', 'export const inDesktopShell = true'],
  ['../../services/extensions', `
    export { EXTENSIONS } from './src/services/extensions.ts'
    export const useSearchExtensions = () => fixture.enabledIds
  `],
  ['../../services/platform', 'export const isLargeScreen = fixture.largeScreen'],
  ['../../shared/useCompactLayout', 'export const useTabletWidth = () => fixture.wide'],
])
const { outputFiles: [output] } = await build({
  entryPoints: ['src/features/search/ExploreLanding.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  packages: 'external',
  loader: { '.css': 'empty' },
  plugins: [{
    name: 'search-extension-view-fixture',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => mocks.has(path) ? { path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        contents: mocks.get(path), resolveDir: process.cwd(),
      }))
    },
  }],
})
const load = new Function('module', 'require', 'fixture', 'localStorage', output.text)
const require = createRequire(import.meta.url)

function landing(enabledIds, { active = true, wide = true, largeScreen = false } = {}) {
  const sources = []
  const queries = []
  const module = { exports: {} }
  load(module, require, {
    enabledIds,
    wide,
    largeScreen,
    useQuery({ queryKey: [, source], enabled }) {
      queries.push(source)
      if (enabled) sources.push(source)
      return { isPending: true }
    },
  }, { getItem: () => null })
  const html = renderToStaticMarkup(createElement(module.exports.ExploreLanding, {
    active, history: ['旅行'], onSearch() {}, onOpenRecommendation() {}, onOpenBiliFeed() {},
  }))
  return { html, sources, queries }
}

test('enables recommendation entries independently and fetches no hot searches by default', () => {
  const empty = landing([])
  assert.doesNotMatch(empty.html, /explore-card|explore-hot/)
  assert.deepEqual(empty.queries, [])
  assert.match(empty.html, /最近搜索/)
  assert.match(empty.html, /旅行/)
  const daily = landing(['daily'])
  assert.match(daily.html, /每日推荐/)
  assert.doesNotMatch(daily.html, /B 站推荐/)
  assert.deepEqual(daily.queries, [])
  const feed = landing(['feed'])
  assert.match(feed.html, /B 站推荐/)
  assert.doesNotMatch(feed.html, /每日推荐/)
})

test('shows and queries only enabled charts on a wide or large-screen layout', () => {
  for (const options of [{ wide: true }, { wide: false, largeScreen: true }]) {
    const view = landing(['bili', 'netease'], options)
    assert.deepEqual(view.sources, ['bilibili', 'netease'])
    assert.match(view.html, /<h2[^>]+>热搜<\/h2>/)
    assert.match(view.html, /网易云热搜/)
    assert.doesNotMatch(view.html, /QQ 音乐热搜|热搜来源/)
  }
})

test('only the selected visible mobile chart is mounted, and one source needs no picker', () => {
  const single = landing(['qq'], { wide: false })
  assert.match(single.html, /QQ 音乐热搜/)
  assert.doesNotMatch(single.html, /热搜来源/)
  assert.deepEqual(single.queries, ['qq'])
  const multiple = landing(['bili', 'qq', 'netease'], { wide: false })
  assert.match(multiple.html, /热搜来源/)
  assert.match(multiple.html, /aria-pressed="true">B 站/)
  assert.doesNotMatch(multiple.html, /data-source="(?:qq|netease)"/)
  assert.deepEqual(multiple.queries, ['bilibili'])
  assert.deepEqual(multiple.sources, ['bilibili'])
})

test('an inactive search page does not activate its charts', () => {
  const view = landing(['bili', 'qq', 'netease'], { active: false })
  assert.match(view.html, /class="explore-landing" hidden=""/)
  assert.deepEqual(view.sources, [])
})
