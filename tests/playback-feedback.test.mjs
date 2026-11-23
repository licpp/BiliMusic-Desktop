import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
async function moduleAt(path){const r=await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'node'});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)}
const {progressAtPointer,progressAtPointerInRect}=await moduleAt('src/domain/playbackProgress.ts')
const {lyricDisplayText}=await moduleAt('src/domain/lyricDisplay.ts')
const {lyricAt,systemLrc}=await moduleAt('src/domain/lyricTimeline.ts')
test('progress drag follows pointer coordinates, clamps outside the slider and supports long videos',()=>{
 assert.equal(progressAtPointer(150,50,200,180),90)
 assert.equal(progressAtPointer(-20,50,200,180),0)
 assert.equal(progressAtPointer(400,50,200,180),180)
 assert.equal(progressAtPointer(250,50,400,624512),312256)
 for(const values of [[NaN,0,100,300],[50,0,0,300],[50,0,100,-1]])assert.equal(progressAtPointer(...values),0)
})
test('fullscreen seek follows the rotated track when the viewport remains in portrait',()=>{
 const rotated={left:40,top:100,width:24,height:400}
 assert.equal(progressAtPointerInRect(60,300,rotated,3600),1800)
 assert.equal(progressAtPointerInRect(30,450,rotated,3600),3150)
 const landscape={left:40,top:100,width:400,height:24}
 assert.equal(progressAtPointerInRect(240,104,landscape,3600),1800)
})
test('musical decorations are hidden without changing words, punctuation or the stored lyric',()=>{
 const source='♪ 哦，我不明白 ♫ 🎵';assert.equal(lyricDisplayText(source),' 哦，我不明白  ')
 assert.equal(source,'♪ 哦，我不明白 ♫ 🎵')
 assert.equal(lyricDisplayText('永远，永远。'),'永远，永远。')
})
test('late AI cues retain their absolute time through native LRC export and index lookup',()=>{
 const lines=Array.from({length:40001},(_,i)=>({text:`字幕 ${i}`,timeMs:i*15500,endTimeMs:i*15500+10000}))
 assert.equal(lyricAt(lines,620001000),40000)
 assert.equal(lyricAt(lines,620010000,false),-1)
 assert.match(systemLrc(lines,0).split('\n').at(-1),/^\[10333:20\.000\]字幕 40000$/)
})

const {subtitleCoverageEnd}=await moduleAt('src/domain/subtitleCoverage.ts')
test('missing subtitle tail is identified without mistaking short outros or cue gaps for missing data',()=>{
 assert.equal(subtitleCoverageEnd([{timeMs:3200000,endTimeMs:3236920,text:'end'}],8563),3236.92)
 assert.equal(subtitleCoverageEnd([{timeMs:200000,endTimeMs:211200,text:'end'}],214),undefined)
 assert.equal(subtitleCoverageEnd([{timeMs:200000,endTimeMs:211200,text:'end'}],260),undefined)
 assert.equal(subtitleCoverageEnd([],8563),undefined)
 assert.equal(subtitleCoverageEnd(undefined,8563),undefined)
})
