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
