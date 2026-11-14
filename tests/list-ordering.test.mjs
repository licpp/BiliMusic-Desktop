import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const out=await build({entryPoints:['src/services/listOrdering.ts'],bundle:true,write:false,platform:'node',format:'cjs'}),module={exports:{}}
new Function('require','module','exports',out.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
const {rankChanges,rankList,sortList,sortTracks}=module.exports
const pad=n=>BigInt(n).toString().padStart(20,'0')
test('one drag changes one rank after initial setup; repeated saves are no-ops',()=>{
 const ids=Array.from({length:500},(_,i)=>`folder:${i}`)
 const initial=rankChanges(ids,[]);assert.equal(initial.length,500)
 const moved=[...ids];moved.splice(150,0,moved.splice(400,1)[0])
 const changes=rankChanges(moved,initial);assert.equal(changes.length,1)
 const merged=initial.map(p=>changes.find(c=>c.entity===p.entity)||p)
 assert.deepEqual(rankList(ids,merged,id=>id),moved)
 assert.deepEqual(rankChanges(moved,merged),[])
})
test('exhausted gaps rebalance safely; duplicate ids are rejected',()=>{
 const prefs=[{entity:'a',displayRank:pad(1)},{entity:'b',displayRank:pad(2)}]
 const changes=rankChanges(['a','c','b'],prefs),all=[...prefs.filter(p=>!changes.some(c=>c.entity===p.entity)),...changes]
 assert.deepEqual(rankList(['b','a','c'],all,id=>id),['a','c','b'])
 assert.throws(()=>rankChanges(['a','a'],[]))
})
test('dates use actual timestamps, missing dates stay last in both directions and inputs remain untouched',()=>{
 const rows=[{id:'a',name:'第10首',date:100},{id:'b',name:'第2首',date:200},{id:'c',name:'未定'}],info=x=>x
 assert.deepEqual(sortList(rows,'date:desc',info).map(x=>x.id),['b','a','c'])
 assert.deepEqual(sortList(rows,'date:asc',info).map(x=>x.id),['a','b','c'])
 assert.deepEqual(sortList(rows,'name:asc',info).map(x=>x.id).filter(x=>x!=='c'),['b','a'])
 assert.deepEqual(rows.map(x=>x.id),['a','b','c'])
 assert.deepEqual(sortList(rows,'source:desc',info).map(x=>x.id),['c','b','a'])
})
test('multipart videos remain grouped with ascending P numbers when reversing or sorting a playlist',()=>{
 const rows=[{id:'a2',title:'P2',source:{bvid:'a',page:2}},{id:'a1',title:'P1',source:{bvid:'a',page:1}},{id:'b',title:'B',source:{bvid:'b',page:1}}]
 assert.deepEqual(sortTracks(rows,'source:desc',{}).map(x=>x.id),['b','a1','a2'])
})
