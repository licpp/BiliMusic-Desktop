import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const output = await build({ entryPoints:['src/services/syncAttention.ts'], bundle:true, write:false, format:'cjs', platform:'node' })
const module = { exports:{} }
new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { useSyncAttention:store, reportSyncOutcome:outcome, reportSyncError:error, clearSyncAttention:clear, revealSync:reveal } = module.exports
const good = { conflicts:[], records:1, bytes:20, changed:false }
test('conflicts remain visible until resolved; independent statistics success cannot clear them', () => {
  clear(); outcome({...good, conflicts:[{key:'playlist:a',field:'__present',local:true,remote:false}]})
  error('statistics',true); error('statistics',false)
  assert.match(store.getState().library,/1 处/)
  assert.equal(store.getState().outcome.conflicts.length,1)
  outcome(good)
  assert.equal(store.getState().library,''); assert.equal(store.getState().outcome,null)
})
test('errors in either domain are visible and clear independently after success', () => {
  clear(); error('library',true); error('statistics',true)
  outcome(good)
  assert.equal(store.getState().library,''); assert.ok(store.getState().statistics)
  error('statistics',false); assert.equal(store.getState().statistics,'')
})
test('preview needs completion, navigation requests reveal, account/disconnect clears content', () => {
  clear(); outcome(good,true); assert.ok(store.getState().library)
  const before=store.getState().reveal; reveal(); assert.equal(store.getState().reveal,before+1)
  clear(); assert.equal(store.getState().library,''); assert.equal(store.getState().outcome,null)
})
test('actionable failure details survive another domain completing and exclude raw URLs', () => {
  clear()
  error('library',true,'读取同步对象失败：坚果云返回 HTTP 401 https://local.test/private')
  error('statistics',true,'同步资料库账号或版本不匹配')
  assert.equal(store.getState().libraryIssue.kind,'connection')
  assert.equal(store.getState().libraryIssue.status,'401')
  assert.doesNotMatch(JSON.stringify(store.getState().libraryIssue),/local\.test|private/)
  assert.equal(store.getState().statisticsIssue.kind,'data')
  outcome({...good,skipped:true})
  assert.equal(store.getState().libraryIssue.status,'401')
  outcome({...good,importError:'资源暂不可见'})
  assert.equal(store.getState().libraryIssue,null)
  assert.equal(store.getState().library,'部分资料待同步')
  assert.equal(store.getState().statisticsIssue.kind,'data')
  clear()
  assert.equal(store.getState().statisticsIssue,null)
})
