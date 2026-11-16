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
