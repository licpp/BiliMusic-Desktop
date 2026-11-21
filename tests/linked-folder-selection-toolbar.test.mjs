import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query')
const { outputFiles: [output] } = await build({
  entryPoints: ['src/features/library/LinkedFolderView.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  define: { 'import.meta.env': '{}' },
  external: ['react', 'react-dom', '@tanstack/react-query'],
  loader: { '.css': 'empty' },
  plugins: [{
    name: 'linked-folder-selection-fixture',
    setup(builder) {
      builder.onResolve({ filter: /\/(useCompactLayout|useTrackSelection)$/ }, ({ path }) => ({
        namespace: 'fixture', path: path.split('/').at(-1),
      }))
      builder.onLoad({ filter: /useCompactLayout/, namespace: 'fixture' }, () => ({
        contents: 'export const useCompactLayout = () => globalThis.linkedFolderCompact',
      }))
      builder.onLoad({ filter: /useTrackSelection/, namespace: 'fixture' }, () => ({
        contents: `export const BatchTrackActions = () => null;
          export const useTrackSelection = () => ({ selecting: true, selected: [], ids: new Set() });`,
      }))
    },
  }],
})
const mod = { exports: {} }
new Function('exports', 'require', 'module', 'window', output.text)(mod.exports, require, mod, { addEventListener() {} })
const { LinkedFolderView } = mod.exports

function toolbar(compact) {
  globalThis.linkedFolderCompact = compact
  const playlist = { id: 'linked:42', biliFolderId: 42, name: '收藏夹', trackCount: 4 }
  const view = createElement(LinkedFolderView, { playlist, onUnlink() {} })
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, view))
  return html.slice(html.indexOf('class="linked-folder-tools"'), html.indexOf('class="result-list"'))
}

test('compact linked folder groups batch actions, sorting and search in one selection toolbar', () => {
  const html = toolbar(true)
  assert.match(html, /^class="linked-folder-tools" data-selection="compact"/)
  assert.match(html, /linked-selection-controls.*全选.*已选 0.*aria-label="批量操作".*完成/)
  assert.match(html, /library-toolbar-icons.*aria-label="列表排序".*aria-label="搜索歌单中的视频"/)
  assert.doesNotMatch(html, /加入队列|加入歌单|下载所选|移除所选/)
})

test('wide linked folder groups individual selection actions and list tools in the same toolbar', () => {
  const html = toolbar(false)
  assert.match(html, /^class="linked-folder-tools" data-selection="wide"/)
  assert.match(html, /加入队列.*加入歌单.*下载所选.*移除所选.*完成.*library-toolbar-icons.*aria-label="列表排序".*aria-label="搜索歌单中的视频"/)
  assert.doesNotMatch(html, /aria-label="批量操作"/)
})
