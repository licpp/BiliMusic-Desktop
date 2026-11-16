import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const code=await build({entryPoints:['src/domain/lyricAlignment.ts'],bundle:true,write:false,format:'esm',platform:'node'})
const {alignLyricTiming}=await import(`data:text/javascript;base64,${Buffer.from(code.outputFiles[0].text).toString('base64')}`)
const phrases=['风吹过树梢轻轻哼着旋律','当熟悉的歌再次响起','把每段旅程写进音符里','沿着星光找到你的方向','愿所有等待都有回响','让远方的灯火照亮归途','我在四季的尽头等你','请把心事交给晚风']
const lyrics=phrases.map((text,i)=>({text,timeMs:10_000+i*8_000}))
const shifted=(offset,lines=lyrics)=>lines.map(l=>({...l,timeMs:l.timeMs+offset}))
test('absolute positive/negative offsets ignore prior bias and preserve word timing',()=>{
 for(const offset of [-7000,0,1350,12000]){
  const input=structuredClone(lyrics);input[0].words=[{text:input[0].text,startTimeMs:10000,endTimeMs:14000}]
  const before=JSON.stringify(input);const r=alignLyricTiming(input,shifted(offset))
  assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.biasMs,offset);assert.equal(JSON.stringify(input),before)
 }
})
test('typos, punctuation, dialogue and missing lines do not dictate alignment',()=>{
 const captions=shifted(4200).filter((_,i)=>i!==2&&i!==5).map((l,i)=>({...l,text:l.text.replace('旋律','旋绿').replace('方向','方响')+(i%2?'！':''),timeMs:l.timeMs+[0,100,-100,250,0,0][i]}))
 captions.push({text:'你怎么会在这里我一直在找你',timeMs:5000},{text:'我们明天还会再见面的对吗',timeMs:44000})
 const r=alignLyricTiming(lyrics,captions);assert.equal(r.ok,true,JSON.stringify(r));assert.ok(Math.abs(r.biasMs-4200)<=200)
})
test('ASR splits and merges sentences differently from lyric lines',()=>{
 const split=shifted(2500).flatMap(l=>[{text:l.text.slice(0,5),timeMs:l.timeMs},{text:l.text.slice(5),timeMs:l.timeMs+1800}])
 assert.equal(alignLyricTiming(lyrics,split).biasMs,2500)
 const merged=shifted(3000).filter((_,i)=>i%2===0).map((l,i)=>({...l,text:l.text+phrases[i*2+1]}))
 assert.equal(alignLyricTiming(lyrics,merged).biasMs,3000)
})
test('repeated choruses use surrounding unique lines and not the first text occurrence',()=>{
 const song=[...lyrics,...lyrics.map(l=>({...l,timeMs:l.timeMs+90000})),{text:'在漫长的告别之后我们终会重逢',timeMs:170000}]
 const r=alignLyricTiming(song,shifted(2100,song));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.biasMs,2100)
})
test('unrelated speech, a single matching line, credits and repeated short phrases are rejected',()=>{
 for(const captions of [lyrics.map(l=>({...l,text:'他们正在谈论今天的天气和明天的安排'})),[shifted(2000)[0]],lyrics.map(l=>({...l,text:'哦哦哦'}))])assert.equal(alignLyricTiming(lyrics,captions).ok,false)
 const credits=Array.from({length:8},(_,i)=>({text:`作词：${phrases[i]}`,timeMs:i*5000}));assert.equal(alignLyricTiming(credits,shifted(1000,credits)).ok,false)
})
test('edited / different tempo versions and equally plausible repetitions are not auto-applied',()=>{
 const drift=lyrics.map((l,i)=>({...l,timeMs:l.timeMs+2000+(i>=4?9000:0)}))
 assert.equal(alignLyricTiming(lyrics,drift).ok,false)
 const twice=[...shifted(2000),...shifted(102000)];assert.equal(alignLyricTiming(lyrics,twice).ok,false)
})
test('unsupported offsets, malformed timestamps and excessively large input are rejected',()=>{
 assert.deepEqual(alignLyricTiming(lyrics,shifted(40000)),{ok:false,reason:'range'})
 assert.equal(alignLyricTiming(lyrics.map(l=>({...l,timeMs:NaN})),lyrics).ok,false)
 assert.equal(alignLyricTiming(Array.from({length:601},(_,i)=>({...lyrics[i%8],timeMs:i*5000})),lyrics).ok,false)
})

test('100 deterministic noisy subtitles keep the recovered offset within subtitle onset jitter',()=>{
 let seed=941723;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
 for(let scenario=0;scenario<100;scenario++){
  const offset=Math.round(random()*14000-7000)
  const captions=lyrics.filter((_,i)=>i===0||i===7||random()>.3).map(l=>{const chars=Array.from(l.text);if(random()<.55)chars[Math.floor(random()*chars.length)]='呀';return {text:chars.join(''),timeMs:l.timeMs+offset+Math.round((random()-.5)*600)}})
  captions.push({timeMs:500,text:'我们要走了你准备好了吗'},{timeMs:41000,text:'这里是什么地方为什么会来到这里'})
  const r=alignLyricTiming(lyrics,captions);assert.equal(r.ok,true,`${scenario}: ${JSON.stringify(r)}`);assert.ok(Math.abs(r.biasMs-offset)<=400)
 }
})

test('similar ASR dialogue outliers do not veto a dominant exact lyric timeline',()=>{
 const captions=shifted(2500).filter((_,i)=>i!==1&&i!==6)
 captions.push({...lyrics[1],text:lyrics[1].text.replace('歌','哥'),timeMs:lyrics[1].timeMs+9000})
 captions.push({...lyrics[6],text:lyrics[6].text.replace(/.$/,'呀'),timeMs:lyrics[6].timeMs+9000})
 const result=alignLyricTiming(lyrics,captions);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.biasMs,2500)
})

test('repeated lyrics outside the subtitle coverage cannot veto the correctly matched excerpt',()=>{
 const first=lyrics.map((l,i)=>({...l,text:i<2?l.text+l.text:l.text}))
 const full=[...first,...first.slice(2).map(l=>({...l,timeMs:l.timeMs+120000}))]
 const result=alignLyricTiming(full,shifted(7800,first))
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.biasMs,7800)
})

test('an exact phrase in another chorus cannot override its typo-tolerant match in this chorus',()=>{
 const captions=shifted(-250).map((l,i)=>({...l,text:i>=4?l.text.replace(/.$/,'呀'):l.text}))
 captions.push(...shifted(180000,lyrics.slice(4)))
 const result=alignLyricTiming(lyrics,captions)
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.biasMs,-250)
})

test('production credits do not inflate required support or get used as timing evidence',()=>{
 const roles=['词','曲','编曲','制作人','配唱制作','人声录音师','人声编辑','吉他','贝斯','鼓','弦乐录音棚','混音&母带','作词OP','作曲SP','和音','乐队监制','录影棚']
 const credits=Array.from({length:40},(_,i)=>({text:`${roles[i%roles.length]} : 姓名${i}`,timeMs:i*500}))
 const song=shifted(30000)
 const result=alignLyricTiming([...credits,...song],shifted(-2800,song))
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.biasMs,-2800);assert.equal(result.matchedLines,8)
})

test('traditional and simplified text share matching only and preserve original display and word timings',()=>{
 const traditional=['風裡聽見遠方的聲音','時間風乾後你我再無關','縱容著任性的隨意的','放肆的輕易的都已過去','將所有歡脫傾翻以後','讓愛與歲月都留在這裡','難過時總會想起從前','請讓我們帶著希望繼續']
 const simplified=['风里听见远方的声音','时间风干后你我再无关','纵容着任性的随意的','放肆的轻易的都已过去','将所有欢脱倾翻以后','让爱与岁月都留在这里','难过时总会想起从前','请让我们带着希望继续']
 const song=traditional.map((text,i)=>({text,timeMs:20000+i*8000,words:[{text,startTimeMs:20000+i*8000,endTimeMs:24000+i*8000}]}))
 const before=structuredClone(song),captions=simplified.map((text,i)=>({text,timeMs:song[i].timeMs-320}))
 const result=alignLyricTiming(song,captions)
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.biasMs,-320);assert.deepEqual(song,before)
})

test('a sparse but distributed set of reliable ASR lines can align a long song',()=>{
 const positions=[0,7,14,21,28,35]
 const song=Array.from({length:40},(_,i)=>({timeMs:20000+i*5000,text:positions.includes(i)?phrases[positions.indexOf(i)]:`未被识别的另一段叙述第${i}章`}));const captions=positions.map(i=>({...song[i],timeMs:song[i].timeMs+2100}))
 const result=alignLyricTiming(song,captions)
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.biasMs,2100)
})

test('two repeated long phrases need several matches distributed over time',()=>{
 const song=[10000,31000,67000,109000,155000].map((timeMs,i)=>({timeMs,text:phrases[i%2]}))
 const result=alignLyricTiming(song,shifted(400,song))
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.biasMs,400)
 assert.equal(alignLyricTiming(song.slice(0,4),shifted(400,song.slice(0,4))).ok,false)
})

test('chronologically valid timing changes still reject tempo changes, inserted dialogue and wrong versions',()=>{
 for(const kind of ['dialogue','tempo','scattered']){
  const captions=lyrics.map((l,i)=>({...l,timeMs:l.timeMs+1800+(kind==='dialogue'?(i>=4?12000:0):kind==='tempo'?i*1400:(i%2?15000:0))}))
  const result=alignLyricTiming(lyrics,captions)
  assert.equal(result.ok,false,`${kind}: ${JSON.stringify(result)}`)
 }
})

test('hundreds of combined noisy, missing-line and repeated-chorus cases recover the same clock',()=>{
 let seed=782451;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
 for(let scenario=0;scenario<400;scenario++){
  const offset=Math.round(random()*24000-6000)
  const song=[...shifted(20000),...shifted(120000)]
  const captions=shifted(offset,song).filter((_,i)=>i===0||i===15||random()>.2).map(l=>{
   const chars=Array.from(l.text);if(random()<.5)chars[Math.floor(random()*chars.length)]='呀'
   return{...l,text:chars.join(''),timeMs:l.timeMs+Math.round((random()-.5)*800)}
  })
  captions.push({timeMs:1000,text:'大家好欢迎收看今天的节目'},{timeMs:100000,text:'接下来请大家认真听一听'})
  const result=alignLyricTiming(song,captions)
  assert.equal(result.ok,true,`${scenario}: ${JSON.stringify(result)}`);assert.ok(Math.abs(result.biasMs-offset)<=450)
 }
})

test('the winning clock is refitted rather than vetoed by a subtitle onset at the bucket edge',()=>{
 const offsets=[2822,947,2236,3187,1036,844,969,2245]
 const result=alignLyricTiming(lyrics,lyrics.map((l,i)=>({...l,timeMs:l.timeMs+offsets[i]})))
 assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.spreadMs<=1200)
 let seed=524198;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
 for(let scenario=0;scenario<1000;scenario++){
  const captions=lyrics.map(l=>({...l,timeMs:l.timeMs+2000+Math.round((random()-.5)*2400)}))
  const r=alignLyricTiming(lyrics,captions);assert.equal(r.ok,true,`${scenario}: ${JSON.stringify(r)}`);assert.ok(Math.abs(r.biasMs-2000)<=1200)
 }
})

test('one repeated phrase is insufficient even when both time axes contain many copies',()=>{
 const song=Array.from({length:600},(_,i)=>({text:phrases[0],timeMs:10000+i*5000}))
 const captions=Array.from({length:2000},(_,i)=>({text:phrases[0],timeMs:12500+i*5000}))
 assert.deepEqual(alignLyricTiming(song,captions),{ok:false,reason:'insufficient'})
})
