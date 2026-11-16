import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const output=await build({entryPoints:['src/features/lyrics/autoAlignment.ts'],bundle:true,write:false,format:'cjs',platform:'node',plugins:[{name:'subtitle-boundary',setup(b){b.onResolve({filter:/services\/mediaSources$/},()=>({path:'captions',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const getSubtitles=(...args)=>globalThis.aiFixture.list(...args);export const getSubtitleLines=(...args)=>globalThis.aiFixture.lines(...args);'}))}}]})
const m={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
const {automaticLyricBias}=m.exports
const source={provider:'bilibili',bvid:'BV1test',cid:42,page:2}
const lyrics=['风吹过树梢轻轻哼着旋律','当熟悉的歌再次响起','把每段旅程写进音符里','沿着星光找到你的方向'].map((text,i)=>({text,timeMs:10000+i*8000}))
const captions=lyrics.map(l=>({...l,timeMs:l.timeMs+2500}))
test('fetches AI subtitles for the current part, prefers matching language, and leaves display selection untouched',async()=>{
 const calls=[];globalThis.aiFixture={list:async(...a)=>{calls.push(a);return[{language:'zh-CN',ai:false},{language:'ai-en',ai:true},{language:'ai-zh',ai:true}]},lines:async(...a)=>{calls.push(a);return captions}}
 const r=await automaticLyricBias(source,lyrics,()=>true);assert.equal(r.biasMs,2500)
 assert.deepEqual(calls,[[source.bvid,42],[source.bvid,42,'ai-zh']])
})
test('no AI subtitles or incompatible lyric content never produce an offset',async()=>{
 globalThis.aiFixture={list:async()=>[{language:'zh-CN',ai:false}],lines:async()=>{throw Error('must not request manual subtitles')}}
 await assert.rejects(automaticLyricBias(source,lyrics,()=>true),/暂无 AI 字幕/)
 aiFixture.list=async()=>[{language:'ai-zh',ai:true}];aiFixture.lines=async()=>captions.map(l=>({...l,text:'你今天怎么会来这里呢我们准备出去'}))
 await assert.rejects(automaticLyricBias(source,lyrics,()=>true),/手动微调/)
})
test('account, part or operation changes discard delayed data before fetching the next stage',async()=>{
 let valid=true,release,count=0
 globalThis.aiFixture={list:()=>new Promise(r=>release=r),lines:async()=>{count++;return captions}}
 const pending=automaticLyricBias(source,lyrics,()=>valid);valid=false;release([{language:'ai-zh',ai:true}]);assert.equal(await pending,null);assert.equal(count,0)
 valid=true;aiFixture.list=async()=>[{language:'ai-zh',ai:true}];aiFixture.lines=()=>new Promise(r=>release=r)
 const second=automaticLyricBias(source,lyrics,()=>valid);await new Promise(setImmediate);valid=false;release(captions);assert.equal(await second,null)
})
