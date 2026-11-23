import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'

async function moduleUnderTest() {
 const result=await build({stdin:{contents:"export {loadCollectionMetadata} from './src/large-screen/collectionMetadata'; export {advanceAccountEpoch} from './src/services/accountScope'",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'cjs',platform:'node'})
 const module={exports:{}}
 new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
 return module.exports
}
const item={bvid:'up:11',folderId:'folder',title:'',coverUrl:'',uploaderName:'',note:'我的备注'}
test('synced collection metadata hydrates sequentially, preserves grouping and notes, and recovers from a failed card',async()=>{
 globalThis.window={dispatchEvent(){}}
 globalThis.isTauri = true
 const requests=[],writes=[];let release
 mockIPC((cmd,args)=>{
  if(cmd==='bili_creator_catalog') {requests.push(args.mid);if(args.mid===11)return new Promise(resolve=>{release=()=>resolve({data:{card:{name:'UP',face:'https://example.test/up.jpg'}}})});if(args.mid===12)throw Error('offline');return {data:{card:{name:'Other',face:'https://example.test/other.jpg'}}}}
  if(cmd==='account_session')return 'test-session'
  if(cmd==='collections_change'){writes.push(args);return null}
 })
 try{
  const {loadCollectionMetadata}=await moduleUnderTest()
  const first=loadCollectionMetadata(item,0),second=loadCollectionMetadata({...item,bvid:'up:12'},0).catch(e=>e.message),third=loadCollectionMetadata({...item,bvid:'up:13'},0)
  await new Promise(setImmediate);assert.deepEqual(requests,[11]);release()
  assert.deepEqual(await first,{...item,title:'UP',coverUrl:'https://example.test/up.jpg',uploaderName:'UP'})
  assert.equal(await second,'offline');assert.equal((await third).title,'Other')
  assert.deepEqual(requests,[11,12,13]);assert.equal(writes.length,2)
  assert.ok(writes.every(w=>w.action==='cache'&&w.expectedAccountSession==='test-session'&&w.item.folderId==='folder'&&w.item.note==='我的备注'))
 }finally{delete globalThis.isTauri;clearMocks()}
})
test('a late profile response and queued requests cannot populate a newly selected account',async()=>{
 globalThis.window={dispatchEvent(){}}
 globalThis.isTauri = true
 let release,writes=0,reads=0
 mockIPC((cmd)=>{if(cmd==='bili_creator_catalog'){reads++;return new Promise(resolve=>{release=resolve})}if(cmd==='collections_change')writes++})
 try{
  const {loadCollectionMetadata,advanceAccountEpoch}=await moduleUnderTest()
  const first=loadCollectionMetadata(item,0).catch(e=>e.message),second=loadCollectionMetadata({...item,bvid:'up:12'},0).catch(e=>e.message)
  await new Promise(setImmediate);advanceAccountEpoch();release({data:{card:{name:'Old',face:'old.jpg'}}})
  assert.equal(await first,'账号已切换');assert.equal(await second,'账号已切换');assert.equal(writes,0);assert.equal(reads,1)
 }finally{delete globalThis.isTauri;clearMocks()}
})
