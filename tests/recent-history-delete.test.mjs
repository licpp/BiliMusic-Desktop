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
        desktopApi: `export const checkHistoryCloudPresence=async()=>({cloudIds:[],historySync:false})
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

function panel(presence, extra = {}) {
  return renderToStaticMarkup(createElement(HistoryDeletePanel, {
    count: 2, presence, busy: false, error: '', onCancel() {}, onRemove() {}, ...extra,
  }))
}

test('recent batch toolbar only offers delete where the history view wires it', () => {
  const withDelete = renderToStaticMarkup(createElement(BatchTrackActions, { selection, total: 2, onDelete() {} }))
  assert.match(withDelete, /下载所选/)
  assert.match(withDelete, /下载所选[\s\S]*删除[\s\S]*完成/)
  const without = renderToStaticMarkup(createElement(BatchTrackActions, { selection, total: 2 }))
  assert.doesNotMatch(without, /删除|移除所选|隐藏所选/)
})

test('delete dialog fails open to a local-only delete while the cloud check runs', () => {
  const checking = panel({ state: 'checking' })
  assert.match(checking, /正在核对云端播放记录/)
  assert.match(checking, /<details class="history-delete-details">/)
  assert.doesNotMatch(checking, /<details[^>]* open/)
  const danger = checking.match(/<button[^>]*action-danger[^>]*>[^<]*<\/button>/)[0]
  assert.match(danger, /disabled/)
  const failed = panel({ state: 'failed', error: '网络不可用' })
  assert.match(failed, /无法核对云端记录：网络不可用/)
  assert.match(failed, /下次同步可能让它们重新出现/)
  assert.doesNotMatch(failed, /同时删除云端/)
  const local = failed.match(/<button[^>]*action-danger[^>]*>[^<]*<\/button>/)[0]
  assert.doesNotMatch(local, /disabled/)
})

test('expanded hints state what deletion leaves alone, in the app-wide wording', () => {
  const html = panel({ state: 'ready', cloudIds: [], historySync: false, checked: true })
  assert.match(html, /<summary>[^<]*云端没有这些记录，只删除本机记录[^<]*<svg/)
  assert.match(html, /收藏、歌单和下载不受影响，删除不会清除续播进度/)
  assert.doesNotMatch(html, /续播位置/)
})

test('an unchecked cloud state is never presented as "the cloud has none"', () => {
  const unchecked = panel({ state: 'ready', cloudIds: [], historySync: true, checked: false })
  assert.match(unchecked, /云同步未连接，只能删除本机记录/)
  assert.match(unchecked, /恢复连接并同步后可能重新出现/)
  assert.doesNotMatch(unchecked, /云端没有这些记录/)
  assert.doesNotMatch(unchecked, /同时删除云端/)
  const silent = panel({ state: 'ready', cloudIds: [], historySync: false, checked: false })
  assert.doesNotMatch(silent, /恢复连接并同步后可能重新出现/)
})

test('cloud records exist only when the check finds them, and both consequences are stated', () => {
  const none = panel({ state: 'ready', cloudIds: [], historySync: true, checked: true })
  assert.match(none, /云端没有这些记录/)
  assert.doesNotMatch(none, /同时删除云端/)
  assert.match(none, />删除</)
  const some = panel({ state: 'ready', cloudIds: ['a', 'b'], historySync: true, checked: true })
  assert.match(some, /其中 2 条也在云端同步里/)
  assert.match(some, /同步播放记录/)
  assert.match(some, /下一次同步时生效/)
  assert.match(some, /同时删除云端/)
  assert.match(some, />仅删除本机</)
  const silent = panel({ state: 'ready', cloudIds: ['a'], historySync: false, checked: true })
  assert.doesNotMatch(silent, /已开启“同步播放记录”/)
})

test('a failed delete keeps the dialog open with the command error', () => {
  const html = panel({ state: 'ready', cloudIds: [], historySync: false, checked: true }, { error: '账号已切换，请重试' })
  assert.match(html, /role="alert"[^>]*>账号已切换，请重试/)
})
