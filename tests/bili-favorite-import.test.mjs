import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {webcrypto} from 'node:crypto'
const {outputFiles}=await build({entryPoints:['src/services/biliFavoriteImport.ts'],bundle:true,write:false,format:'esm'})
const {importFavoriteFolders}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
if(!globalThis.crypto)globalThis.crypto=webcrypto
const folders=[{id:1,title:'清晨',media_count:1},{id:2,title:'午后',media_count:1},{id:3,title:'夜晚',media_count:1}]
const detail=bvid=>({bvid,aid:1,title:bvid,parts:[{cid:1,page:1,title:'第一首',durationSeconds:120},{cid:2,page:2,title:'第二首',durationSeconds:150}]})
function setup(extra={}) {
 const events=[],waits=[],links=[],writes=[],saved=new Map(),copyIds=new Map()
 const options={folders:folders.slice(0,2),mode:'copy',scope:'account-1',copyIds,stopped:()=>false,progress:text=>events.push(text),result:result=>events.push(result),wait:async ms=>{waits.push(ms)},link:async id=>{links.push(id)},videos:async id=>({medias:[{bvid:`BV${id}`,title:`song ${id}`}],has_more:false}),detail:async bvid=>detail(bvid),save:async(scope,id,name,entries)=>{writes.push({scope,id,name,entries});const tracks=saved.get(id)||new Set();entries.forEach(e=>tracks.add(e.track.id));saved.set(id,tracks);return{id,trackCount:tracks.size}},...extra}
 return {options,events,waits,links,writes,saved,copyIds,run:()=>importFavoriteFolders(options)}
}
test('multiselection processes each linked folder once, reports failures, and continues the rest',async()=>{
 const h=setup({mode:'link',folders,link:async id=>{h.links.push(id);if(id===2)throw Error('收藏夹不可用')}})
 const result=await h.run();assert.deepEqual(h.links,[1,2,3]);assert.deepEqual(result.map(r=>Boolean(r.error)),[false,true,false]);assert.equal(result[2].id,'bili-folder:3')
})
test('copy import paces reads, preserves folder boundaries, expands parts and commits the account scope',async()=>{
 const h=setup(),result=await h.run();assert.deepEqual(result.map(r=>r.count),[2,2]);assert.equal(h.saved.size,2);assert.ok(h.waits.every(ms=>ms===400));assert.equal(h.writes[0].scope,'account-1');assert.equal(h.writes[1].name,'午后');assert.notEqual(h.writes[0].id,h.writes[1].id)
})
test('risk control has bounded backoff and remains visible in progress',async()=>{
 let calls=0;const h=setup({folders:[folders[0]],detail:async bvid=>{if(++calls<3)throw{message:'Bilibili 接口返回错误 -352: limited'};return detail(bvid)}})
 assert.equal((await h.run())[0].count,2);assert.equal(calls,3);assert.ok(h.waits.includes(1500)&&h.waits.includes(3000));assert.ok(h.events.some(e=>typeof e==='string'&&e.includes('重试')))
})
test('persistent rate limits stop a folder after three attempts and surface an error',async()=>{
 let calls=0;const h=setup({folders:[folders[0]],detail:async()=>{calls++;throw{message:'HTTP 429'}}})
 const result=await h.run();assert.equal(calls,3);assert.match(result[0].error,/限制/);assert.equal(h.writes.length,0)
})
test('retrying partial copies reuses their playlist and never duplicates previously committed tracks',async()=>{
 let unavailable=true;const h=setup({folders:[folders[0]],videos:async(id,page)=>{if(page===2&&unavailable)throw Error('收藏夹暂不可用');return page===1?{medias:[{bvid:'BV1',title:'one'}],has_more:true}:{medias:[{bvid:'BV2',title:'two'}],has_more:false}}})
 const first=(await h.run())[0];assert.ok(first.error);assert.equal(first.count,2);unavailable=false;const second=(await h.run())[0];assert.equal(second.id,first.id);assert.equal(second.count,4);assert.equal(h.saved.size,1)
})
test('account changes during detail loading prevent any subsequent writes',async()=>{
 let stopped=false;const h=setup({stopped:()=>stopped,detail:async bvid=>{stopped=true;return detail(bvid)}})
 assert.deepEqual(await h.run(),[]);assert.equal(h.writes.length,0)
})
test('incomplete and empty pages report errors instead of silently completing',async()=>{
 for(const has_more of [true,false]){const h=setup({folders:[folders[0]],videos:async()=>({medias:[],has_more})});assert.ok((await h.run())[0].error);assert.equal(h.writes.length,0)}
})
test('deleted videos are skipped with a partial result and duplicate page entries are not saved twice',async()=>{
 const h=setup({folders:[folders[0]],videos:async()=>({medias:[{bvid:'BV1',title:'one'},{bvid:'BV1',title:'repeat'},{bvid:'gone',title:'gone'}],has_more:false}),detail:async bvid=>{if(bvid==='gone')throw Error('视频已删除');return detail(bvid)}})
 const result=(await h.run())[0];assert.equal(h.writes.length,1);assert.equal(result.count,2);assert.match(result.error,/1 个视频/)
})
