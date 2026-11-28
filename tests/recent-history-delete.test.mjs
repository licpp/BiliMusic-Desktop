import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const { outputFiles: [output] } = await build({
  stdin: {
    contents: `export { HistoryDeletePanel } from './src/features/library/HistoryDeleteDialog'
      export { BatchTrackActions } from './src/features/library/useTrackSelection'`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  plugins: [{
    name: 'recent-history-delete-fixtures',
    setup(builder) {
      const stubs = {
        desktopApi: `export const checkHistoryDeletionScope=async()=>({canSync:false})
          export const removeHistoryRecords=async()=>0
          export const commandErrorMessage=error=>String(error)`,
        accountScope: 'export const accountEpoch=()=>0',
        CollectionDialog: 'export const CollectionDialog=({children})=>children',
        BatchMatchButton: 'export const BatchMatchButton=()=>null',
        LinkedMatchControls: 'export const LinkedMatchButton=()=>null',
        useCompactLayout: 'export const useCompactLayout=()=>false',
        downloadBatch: 'export const useDownloadBatch=selector=>selector({busy:false})',
        downloadRequest: 'export const chooseDownload=()=>{}',
        downloadSelection: `export const prepareDownloadSelection=async()=>({tracks:[],failed:0})
          export const downloadSelectionMessage=()=>''`,
        playerStore: `export const usePlayerStore=selector=>selector({})
          usePlayerStore.getState=()=>({enqueue(){}})`,
        trackActionStore: 'export const chooseTrackPlaylist=()=>{}',
      }
      builder.onResolve(
        { filter: /\/(desktopApi|accountScope|CollectionDialog|BatchMatchButton|LinkedMatchControls|useCompactLayout|downloadBatch|downloadRequest|downloadSelection|playerStore|trackActionStore)$/ },
        args => ({ path: args.path.split('/').at(-1), namespace: 'fixture' }),
      )
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    },
  }],
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', output.text)(require, mod, mod.exports)
const { HistoryDeletePanel, BatchTrackActions } = mod.exports

const track = id => ({ id, source: { provider: 'bilibili', bvid: id, cid: 1, page: 1 }, title: id, artist: '', coverUrl: '', durationSeconds: 60, liked: false, partCount: 1 })
const selection = { selecting: true, ids: new Set(['a', 'b']), selected: [track('a'), track('b')], all() {}, exit() {}, toggle() {} }

function panel(scope, extra = {}) {
  return renderToStaticMarkup(createElement(HistoryDeletePanel, {
    count: 2, scope, busy: false, error: '', onCancel() {}, onRemove() {}, onRetry() {}, ...extra,
  }))
}

test('recent batch toolbar only offers delete where the history view wires it', () => {
  const withDelete = renderToStaticMarkup(createElement(BatchTrackActions, { selection, total: 2, onDelete() {} }))
  assert.match(withDelete, /下载所选/)
  assert.match(withDelete, /下载所选[\s\S]*删除[\s\S]*完成/)
  const without = renderToStaticMarkup(createElement(BatchTrackActions, { selection, total: 2 }))
  assert.doesNotMatch(without, /删除|移除所选|隐藏所选/)
})

test('delete waits for the local settings check and offers retry if it fails', () => {
  const checking = panel({ state: 'checking' })
  assert.match(checking, /正在读取同步设置/)
  assert.match(checking, /<button[^>]*action-danger[^>]*disabled/)
  const failed = panel({ state: 'failed', error: '读取同步设置失败' })
  assert.match(failed, /role="alert"[^>]*>读取同步设置失败/)
  assert.match(failed, />重试</)
  assert.doesNotMatch(failed, /action-danger/)
})

test('delete has one action and states the configured sync scope', () => {
  const local = panel({ state: 'ready', canSync: false })
  assert.match(local, /仅删除本机播放记录/)
  assert.equal([...local.matchAll(/>删除</g)].length, 1)
  const synced = panel({ state: 'ready', canSync: true })
  assert.match(synced, /其他设备将在下次同步时移除/)
  assert.equal([...synced.matchAll(/>删除</g)].length, 1)
})

test('a failed delete keeps the dialog open with the command error', () => {
  const html = panel({ state: 'ready', canSync: true }, { error: '账号已切换，请重试' })
  assert.match(html, /role="alert"[^>]*>账号已切换，请重试/)
})
