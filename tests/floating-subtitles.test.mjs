import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const built=await build({entryPoints:['src/features/lyrics/lyricTimeline.ts'],bundle:true,write:false,format:'esm',platform:'node'})
const {floatingTimeline,floatingLinePair,floatingLineSlots,lyricScrollProgress}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const lyrics=[{timeMs:1000,text:'保存的歌词',words:[{text:'保存的歌词',startTimeMs:1000,endTimeMs:2000}]}]
const captions=[{timeMs:3000,endTimeMs:4500,text:'AI 字幕'},{timeMs:6000,endTimeMs:7000,text:'下一句'}]
const scope='1:BVtest:123'
test('AI and manual subtitles replace saved lyrics and never inherit the lyric timing bias',()=>{
 const result=floatingTimeline(lyrics,850,scope,{scope,active:true,lines:captions})
 assert.equal(result.lines,captions);assert.equal(result.biasMs,0);assert.equal(result.subtitles,true)
 const manual=[{timeMs:2000,endTimeMs:4000,text:'手工字幕'}]
 assert.equal(floatingTimeline(lyrics,-300,scope,{scope,active:true,lines:manual}).lines,manual)
})
test('disabling subtitles or waiting for their request restores stored words and timing',()=>{
 for(const state of [{scope,active:false,lines:captions},{scope,active:true,lines:undefined}]){
  const result=floatingTimeline(lyrics,850,scope,state)
  assert.equal(result.lines,lyrics);assert.equal(result.biasMs,850);assert.equal(result.subtitles,false)
 }
 assert.deepEqual(floatingTimeline(lyrics,850,scope,{scope,active:true,lines:[]}),{lines:[],biasMs:0,subtitles:true})
})
test('captions from another part or an earlier account never appear in the current overlay',()=>{
 for(const nextScope of ['1:BVtest:456','2:BVtest:123','']){
  assert.equal(floatingTimeline(lyrics,50,nextScope,{scope,active:true,lines:captions}).lines,lyrics)
 }
})
test('subtitle display respects precise start/end boundaries, gaps and backward seeks',()=>{
 assert.equal(floatingLinePair(captions,2999,true).line,undefined)
 assert.equal(floatingLinePair(captions,3000,true).line,captions[0])
 assert.equal(floatingLinePair(captions,4499,true).active,0)
 const gap=floatingLinePair(captions,4500,true)
 assert.equal(gap.line,undefined);assert.equal(gap.next,captions[1])
 assert.equal(floatingLinePair(captions,6000,true).line,captions[1])
 assert.equal(floatingLinePair(captions,7000,true).line,undefined)
 assert.equal(floatingLinePair(captions,3500,true).line,captions[0])
})
test('ordinary desktop lyrics continue holding the completed line until the next starts',()=>{
 const lines=[{timeMs:1000,endTimeMs:2000,text:'一句'},{timeMs:4000,text:'下一句'}]
 assert.equal(floatingLinePair(lines,3000).line,lines[0]);assert.equal(floatingLinePair(lines,4000).line,lines[1])
})

test('two lyric rows alternate without moving the upcoming sentence to another row',()=>{
 const lines=[0,1,2,3].map(i=>({timeMs:i*1000,text:`line ${i}`}))
 const first=floatingLineSlots(lines,500),second=floatingLineSlots(lines,1500),third=floatingLineSlots(lines,2500)
 assert.equal(first[1].line.text,'line 1');assert.equal(second[1].line.text,'line 1');assert.equal(second[1].active,true)
 assert.equal(second[0].line.text,'line 2');assert.equal(third[0].line.text,'line 2');assert.equal(third[0].active,true)
 assert.equal(third[1].line.text,'line 3')
 const last=floatingLineSlots(lines,3500);assert.equal(last[1].line.text,'line 3');assert.equal(last[0].line.text,'line 2')
 assert.deepEqual(floatingLineSlots(lines,500).map(s=>s.index),[0,1],'seeking uses the same physical row mapping')
 const gap=floatingLineSlots([{timeMs:0,endTimeMs:100,text:'A'},{timeMs:500,endTimeMs:600,text:'B'}],300,true)
 assert.equal(gap[0].line.text,'A');assert.equal(gap[1].line.text,'B');assert.ok(gap.every(s=>!s.active))
})

test('overflow scrolling follows timed words and holds during the gap between words',()=>{
 const line={timeMs:1000,text:'你好世界',words:[{text:'你好',startTimeMs:1000,endTimeMs:2000},{text:'世界',startTimeMs:4000,endTimeMs:6000}]}
 assert.equal(lyricScrollProgress(line,500),0)
 assert.equal(lyricScrollProgress(line,1500),.25)
 assert.equal(lyricScrollProgress(line,2000),.5)
 assert.equal(lyricScrollProgress(line,3500),.5)
 assert.equal(lyricScrollProgress(line,5000),.75)
 assert.equal(lyricScrollProgress(line,7000),1)
 assert.equal(lyricScrollProgress(line,1500),.25,'backward seeks return to the earlier text position')
 assert.equal(lyricScrollProgress(line,5000),lyricScrollProgress(line,5000),'a paused media clock does not move text')
})
test('untimed lines interpolate across line duration and clamp at both ends',()=>{
 const line={timeMs:1000,text:'一句没有逐词时间的歌词'}
 assert.equal(lyricScrollProgress(line,0,5000),0)
 assert.equal(lyricScrollProgress(line,3000,5000),.5)
 assert.equal(lyricScrollProgress(line,6000,5000),1)
 assert.equal(lyricScrollProgress({...line,endTimeMs:3000},2000,5000),.5)
 assert.equal(lyricScrollProgress(line,100000),1,'the final line has a finite fallback duration')
 const emoji={timeMs:0,text:'你🎵',words:[{text:'你',startTimeMs:0,endTimeMs:1000},{text:'🎵',startTimeMs:1000,endTimeMs:2000}]}
 assert.equal(lyricScrollProgress(emoji,1000),.5,'supplementary characters count once')
})
