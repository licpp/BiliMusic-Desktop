import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)

const settingsMocks = new Map([
  ['../../services/extensions', `
    export { EXTENSIONS } from './src/services/extensions.ts'
    export const useExtensionPreferences = selector => selector({ enabledIds: fixture.enabledIds, setEnabled() {} })
  `],
])
const { outputFiles: [settingsBundle] } = await build({
  entryPoints: ['src/features/settings/ExtensionsSettings.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  packages: 'external',
  loader: { '.css': 'empty' },
  plugins: [{
    name: 'extension-settings-preview-fixture',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => settingsMocks.has(path) ? { path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        contents: settingsMocks.get(path), resolveDir: process.cwd(),
      }))
    },
  }],
})
const loadSettings = new Function('module', 'require', 'fixture', settingsBundle.text)

function settings(enabledIds, onPreviewOpen) {
  const module = { exports: {} }
  loadSettings(module, require, { enabledIds })
  return renderToStaticMarkup(createElement(module.exports.ExtensionsSettings,
    onPreviewOpen ? { onPreviewOpen } : {}))
}

const opensSearch = () => {}
const card = /<span class="explore-card explore-daily"><span class="explore-card-mark explore-date" aria-hidden="true"><strong>\d{2}<\/strong><small>\d{2}月<\/small><\/span>/

test('the search-page preview is always shown, switched on or not', () => {
  for (const enabledIds of [[], ['feed'], ['daily', 'bili']]) {
    const html = settings(enabledIds, opensSearch)
    assert.match(html, /class="extension-preview"/, `${enabledIds} shows the preview`)
    assert.match(html, card)
    assert.match(html, /搜索首页预览/)
    assert.match(html, /aria-expanded="true"/)
    assert.match(html, />收起</)
    // The picture of the search page is not a second focus target of its own.
    assert.doesNotMatch(html, /data-focus="explore-daily"/)
    assert.doesNotMatch(html, /class="extension-preview-explain"/)
  }
})

test('only an enabled daily recommendation leads to the search page', () => {
  const off = settings([], opensSearch)
  assert.match(off, /aria-disabled="true"/)
  assert.match(off, /搜索首页预览 · 启用后可前往/)
  assert.match(off, /aria-label="每日推荐尚未启用"/)

  const on = settings(['daily'], opensSearch)
  assert.match(on, /aria-disabled="false"/)
  assert.match(on, /搜索首页预览 · 点击前往/)
  assert.match(on, /aria-label="前往搜索首页查看每日推荐"/)
  assert.match(on, /class="extension-preview-frame extension-preview-link"/)
})

test('without a search stage to open the preview stays a picture', () => {
  const html = settings(['daily'])
  assert.match(html, card)
  assert.match(html, /class="extension-preview-frame"/)
  assert.doesNotMatch(html, /extension-preview-link|aria-disabled|aria-label="前往搜索首页查看每日推荐"/)
  assert.match(html, />搜索首页预览</)
})
