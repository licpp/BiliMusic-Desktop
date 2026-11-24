import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const output=await build({entryPoints:['src/features/player/listPlayback.ts'],bundle:true,write:false,platform:'node',format:'esm'})
const {prepareListPlayback}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
const row=(cid,resolveParts=false)=>({id:`bilibili:BV123:${cid}`,source:{provider:'bilibili',bvid:'BV123',cid},title:'part',resolveParts})
test('unexpanded checkpoint resolves exact non-first part and retains its position',async()=>{
 const result=await prepareListPlayback([row(0,true)],{bvid:'BV123',cid:2,positionMs:42000},async()=>[row(1),row(2)],()=>true)
 assert.equal(result.trackId,row(2).id);assert.equal(result.startAt,42);assert.equal(result.queue.length,2)
})
test('missing checkpoint never falls back to the first part and stale resolution does not commit',async()=>{
 assert.equal(await prepareListPlayback([row(0,true)],{bvid:'BV123',cid:3,positionMs:42},async()=>[row(1),row(2)],()=>true),null)
 let current=true
 assert.equal(await prepareListPlayback([row(0,true)],{bvid:'BV123',cid:2,positionMs:42},async()=>{current=false;return[row(2)]},()=>current),null)
})
test('play visible results uses only the supplied visible collection',async()=>{
 const result=await prepareListPlayback([row(2)],undefined,async()=>{throw Error('unneeded')},()=>true)
 assert.deepEqual(result.queue,[row(2)]);assert.equal(result.trackId,row(2).id)
})
test('hidden resume chooses the next original part or wraps, starting at zero',async()=>{
 const entries=[row(1),row(2),row(3)]
 let result=await prepareListPlayback(entries,{bvid:'BV123',cid:2,positionMs:42000},async()=>[],()=>true,t=>t.source.cid!==2)
 assert.equal(result.trackId,row(3).id);assert.equal(result.startAt,0);assert.equal(result.queue.length,3)
 result=await prepareListPlayback(entries,{bvid:'BV123',cid:3,positionMs:42000},async()=>[],()=>true,t=>t.source.cid===1)
 assert.equal(result.trackId,row(1).id);assert.equal(result.startAt,0)
 assert.equal(await prepareListPlayback(entries,{bvid:'BV123',cid:2,positionMs:42000},async()=>[],()=>true,()=>false),null)
})
test('a hidden whole BV checkpoint skips its lazy expansion without a network request',async()=>{
 const first=row(0,true),second={...row(5),id:'bilibili:BVnext:5',source:{provider:'bilibili',bvid:'BVnext',cid:5}}
 const result=await prepareListPlayback([first,second],{bvid:'BV123',cid:2,positionMs:60000},async()=>{throw Error('must not request a hidden BV')},()=>true,t=>t.source.bvid!=='BV123')
 assert.equal(result.trackId,second.id);assert.equal(result.startAt,0)
})
test('offline resume chooses the saved checkpoint part without replacing the source BV', async () => {
 const group=row(0,true), saved=row(2), entries=[group]
 const result=await prepareListPlayback(entries,{bvid:'BV123',cid:2,positionMs:42000},async()=>{throw Error('offline resume must not resolve remotely')},()=>true,()=>true,()=>[row(1),saved])
 assert.deepEqual(result,{queue:entries,trackId:saved.id,sourceTrackId:group.id,startAt:42})
})
test('offline resume skips an unsaved BV in source order without transferring its position', async () => {
 const group=row(0,true), next={...row(5),id:'bilibili:BVNEXT:5',source:{provider:'bilibili',bvid:'BVNEXT',cid:5}}
 const result=await prepareListPlayback([group,next],{bvid:'BV123',cid:2,positionMs:42000},async()=>{throw Error('offline resume must not resolve remotely')},()=>true,()=>true,t=>t===next?[t]:[])
 assert.deepEqual(result,{queue:[group,next],trackId:next.id,sourceTrackId:next.id,startAt:0})
})
