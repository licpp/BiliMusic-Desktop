import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const output=await build({entryPoints:['src/features/lyrics/autoAlignment.ts'],bundle:true,write:false,format:'cjs',platform:'node',plugins:[{name:'subtitle-boundary',setup(b){b.onResolve({filter:/services\/mediaSources$/},()=>({path:'captions',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const getSubtitles=(...args)=>globalThis.aiFixture.list(...args);export const getSubtitleLines=(...args)=>globalThis.aiFixture.lines(...args);'}))}}]})
const m={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
const {automaticLyricBias}=m.exports
const source={provider:'bilibili',bvid:'BV1test',cid:42,page:2}
const timeline=texts=>texts.map((text,i)=>({text,timeMs:10000+i*8000}))
const atOffset=lines=>lines.map(l=>({...l,timeMs:l.timeMs+2500}))
const lyrics=timeline(['风吹过树梢轻轻哼着旋律','当熟悉的歌再次响起','把每段旅程写进音符里','沿着星光找到你的方向'])
const japanese=timeline(['夜が明けるまで君の名前を呼ぶよ','遠くに消えた雲をもう一度見上げる','心に残る景色を忘れないで歩こう','風の向こうへ届くように歌い続ける'])
const english=timeline(['I keep walking until the morning comes','The ocean carries every word we said','Another quiet night beneath the stars','I hear your voice across the empty street'])
const captions=atOffset(lyrics)
const choice=(language,languageKey,ai=true)=>({language,languageKey,ai})
test('fetches AI subtitles for the current part, prefers matching language, and leaves display selection untouched',async()=>{
 const calls=[];globalThis.aiFixture={list:async(...a)=>{calls.push(a);return[choice('zh-CN','zh',false),choice('ai-en','en'),choice('ai-zh','zh')]},lines:async(...a)=>{calls.push(a);return captions}}
 const r=await automaticLyricBias(source,lyrics,()=>true);assert.equal(r.biasMs,2500)
 assert.deepEqual(calls,[[source.bvid,42],[source.bvid,42,'ai-zh']])
})
test('Japanese kana and kanji select Japanese subtitles despite Chinese credits and a Chinese first choice',async()=>{
 const calls=[]
 globalThis.aiFixture={list:async()=>[choice('ai-zh','zh'),choice('ai-en','en'),choice('ai-ja','ja')],
   lines:async(_bv,_cid,language)=>{calls.push(language);return atOffset(japanese)}}
 const withCredits=[{timeMs:0,text:'作詞：這裡是用了許多繁體字的製作名單與製作人資訊'},...japanese]
 assert.equal((await automaticLyricBias(source,withCredits,()=>true)).biasMs,2500)
 assert.deepEqual(calls,['ai-ja'])
})
test('a failed matching AI track can fall back to original-language published captions',async()=>{
 const calls=[]
 globalThis.aiFixture={list:async()=>[choice('ai-zh','zh'),choice('en-US','en',false),choice('ai-en','en')],
   lines:async(_bv,_cid,language)=>{calls.push(language);if(language==='ai-en')throw Error('暂时不可用');return atOffset(english)}}
 assert.equal((await automaticLyricBias(source,english,()=>true)).biasMs,2500)
 assert.deepEqual(calls,['ai-en','en-US'])
})
test('timed Chinese lyric translations can align when the video only supplies Chinese AI captions',async()=>{
 globalThis.aiFixture={list:async()=>[choice('ai-zh','zh')],lines:async()=>captions}
 const translated=english.map((line,i)=>({...line,translation:lyrics[i].text}))
 assert.equal((await automaticLyricBias(source,translated,()=>true)).biasMs,2500)
 await assert.rejects(automaticLyricBias(source,english,()=>true),/手动微调/)
})
test('no usable subtitle choice or incompatible lyric content never produces an offset',async()=>{
 globalThis.aiFixture={list:async()=>[choice('en-US','en',false)],lines:async()=>{throw Error('must not request unrelated published subtitles')}}
 await assert.rejects(automaticLyricBias(source,lyrics,()=>true),/暂无可用于对齐的字幕/)
 aiFixture.list=async()=>[choice('ai-zh','zh')];aiFixture.lines=async()=>captions.map(l=>({...l,text:'你今天怎么会来这里呢我们准备出去'}))
 await assert.rejects(automaticLyricBias(source,lyrics,()=>true),/手动微调/)
})
test('account, part or operation changes discard delayed data before fetching the next stage',async()=>{
 let valid=true,release,count=0
 globalThis.aiFixture={list:()=>new Promise(r=>release=r),lines:async()=>{count++;return captions}}
 const pending=automaticLyricBias(source,lyrics,()=>valid);valid=false;release([choice('ai-zh','zh')]);assert.equal(await pending,null);assert.equal(count,0)
 valid=true;aiFixture.list=async()=>[choice('ai-zh','zh'),choice('ai-en','en')];aiFixture.lines=()=>new Promise(r=>release=r)
 const second=automaticLyricBias(source,lyrics,()=>valid);await new Promise(setImmediate);valid=false;release(captions);assert.equal(await second,null)
})
