import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const { outputFiles: [output] } = await build({
  entryPoints: ['src/features/library/HubToolbar.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  jsx: 'automatic',
})
const mod = { exports: {} }
new Function('exports', 'require', 'module', output.text)(mod.exports, require, mod)
const { HubToolbar } = mod.exports

function render(actionsHost) {
  return renderToStaticMarkup(createElement(HubToolbar, {
    className: 'listening-tools',
    summary: '2 个歌单',
    actions: createElement('button', { type: 'button' }, '新建歌单'),
    actionsHost,
  }))
}

test('wide hub panes reserve the summary row without rendering actions below the tabs', () => {
  const html = render(null)
  assert.match(html, /data-actions-in-header=""/)
  assert.match(html, /2 个歌单/)
  assert.doesNotMatch(html, /新建歌单/)
})

test('compact hub panes keep their actions next to the summary', () => {
  const html = render(undefined)
  assert.doesNotMatch(html, /data-actions-in-header/)
  assert.match(html, /新建歌单/)
})
