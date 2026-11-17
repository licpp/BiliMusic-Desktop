import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const built=await build({entryPoints:['src/domain/shuffle.ts'],bundle:true,write:false,format:'cjs'})
const m={exports:{}};new Function('module','exports',built.outputFiles[0].text)(m,m.exports)
export const {ShuffleDeck}=m.exports
export const rng=seed=>()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296)
const items=Array.from({length:80},(_,i)=>({id:String(i),artist:`artist${i%8}`,bvid:`BV${Math.floor(i/4)}`}))
test('shuffle covers every track exactly once each round and does not repeat across boundaries',()=>{
 for(let seed=1;seed<=100;seed++){
  const deck=new ShuffleDeck(rng(seed));let current='0'
  const first=[current]
  for(let i=1;i<items.length;i++){current=deck.target(items,current,1);first.push(current)}
  assert.equal(new Set(first).size,items.length)
  for(let round=0;round<3;round++){
   const seen=[]
   for(let i=0;i<items.length;i++){const next=deck.target(items,current,1);assert.notEqual(next,current);seen.push(next);current=next}
   assert.equal(new Set(seen).size,items.length)
  }
 }
})
test('previous walks actual history, next replays it before drawing; manual selection branches history',()=>{
 const d=new ShuffleDeck(rng(42)),queue=items.slice(0,9);let current='0';const path=[current]
 for(let i=0;i<5;i++){current=d.target(queue,current,1);path.push(current)}
 for(let i=4;i>=1;i--){current=d.target(queue,current,-1);assert.equal(current,path[i])}
 for(let i=2;i<=5;i++){current=d.target(queue,current,1);assert.equal(current,path[i])}
 current=d.target(queue,current,-1)
 const manual=queue.find(i=>!path.includes(i.id)).id
 d.observe(queue,manual);assert.equal(d.target(queue,manual,-1),current)
})
test('queue edits preserve pending order, prune removed rows and include added tracks without starvation',()=>{
 const d=new ShuffleDeck(rng(3));let queue=items.slice(0,10);let current='0'
 current=d.target(queue,current,1)
 const pending=d.snapshot().remaining.filter(id=>id!=='5')
 queue=queue.filter(i=>i.id!=='5').concat(items.slice(10,15))
 d.observe(queue,current)
 assert.deepEqual(d.snapshot().remaining.filter(id=>Number(id)<10),pending)
 assert.ok(!d.snapshot().history.includes('5'))
 const rest=[]
 for(let i=0;i<pending.length+5;i++){current=d.target(queue,current,1);rest.push(current)}
 assert.equal(new Set(rest).size,rest.length)
 for(let id=10;id<15;id++)assert.ok(rest.includes(String(id)))
})
test('local restore keeps next/previous and malformed snapshots are ignored; empty and singleton queues work',()=>{
 const d=new ShuffleDeck(rng(7));let current='0';for(let i=0;i<6;i++)current=d.target(items,current,1)
 const restored=new ShuffleDeck(rng(99),d.snapshot())
 assert.equal(restored.target(items,current,1),d.target(items,current,1))
 assert.equal(new ShuffleDeck().target([], '',1),undefined)
 assert.equal(new ShuffleDeck().target([items[0]],'0',1),'0')
 for(const bad of [{version:1},{version:1,remaining:[],played:[],history:[],cursor:99}])assert.doesNotThrow(()=>new ShuffleDeck(Math.random,bad))
})
test('freshness candidates reduce artist and BV clustering without suppressing tracks',()=>{
 let scored=0,uniform=0
 for(let seed=1;seed<=200;seed++){
  const deck=new ShuffleDeck(rng(seed));let current='0'
  for(let i=1;i<items.length;i++){const next=deck.target(items,current,1);scored+=Number(items[Number(next)].artist===items[Number(current)].artist)+Number(items[Number(next)].bvid===items[Number(current)].bvid);current=next}
  const random=rng(seed);const ids=items.slice(1).map(i=>i.id)
  for(let i=ids.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[ids[i],ids[j]]=[ids[j],ids[i]]}
  current='0';for(const next of ids){uniform+=Number(items[Number(next)].artist===items[Number(current)].artist)+Number(items[Number(next)].bvid===items[Number(current)].bvid);current=next}
 }
 assert.ok(scored<uniform*.9,`${scored} vs ${uniform}`)
})
test('history stays bounded and metadata updates do not consume randomness or reset the round',()=>{
 let draws=0;const random=rng(5);const d=new ShuffleDeck(()=>{draws++;return random()});let current='0'
 for(let i=0;i<400;i++)current=d.target(items,current,1)
 assert.equal(d.snapshot().history.length,200)
 const before=d.snapshot(),count=draws
 for(let i=0;i<50;i++)d.observe(items.map(item=>({...item,artist:'updated'})),current)
 assert.equal(draws,count);assert.deepEqual(d.snapshot(),before)
})
test('new-round freshness lowers recent tracks in the early prefix across fixed seeds',()=>{
 const rows=items.map(item=>({...item,artist:'',bvid:''}));let recentCount=0
 for(let seed=1;seed<=100;seed++){
  const d=new ShuffleDeck(rng(seed));let current='0'
  for(let i=1;i<80;i++)current=d.target(rows,current,1)
  const recent=new Set(d.snapshot().history.slice(-50))
  for(let i=0;i<20;i++){current=d.target(rows,current,1);recentCount+=Number(recent.has(current))}
 }
 assert.ok(recentCount/100<12,`${recentCount/100} vs uniform expectation 12.5`)
})
test('ten-thousand-track queues remain complete; duplicate identities use their first metadata consistently',()=>{
 const rows=Array.from({length:10000},(_,i)=>({id:String(i),artist:'',bvid:''}))
 const d=new ShuffleDeck(rng(23));d.observe(rows,'0')
 assert.equal(d.snapshot().remaining.length,9999)
 assert.equal(new Set(d.snapshot().remaining).size,9999)
 const normal=new ShuffleDeck(rng(9)),duplicates=new ShuffleDeck(rng(9))
 const mixed=items.flatMap(item=>[item,{...item,artist:'duplicate',bvid:'duplicate'}])
 assert.equal(normal.target(items,'0',1),duplicates.target(mixed,'0',1))
 assert.deepEqual(normal.snapshot(),duplicates.snapshot())
})
