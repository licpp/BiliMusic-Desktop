import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
async function moduleAt(path) {
  const built = await build({ entryPoints:[path], bundle:true, write:false, format:'esm', platform:'node' })
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
}
const { createNativeClock } = await moduleAt('src/features/player/nativeClock.ts')
const { touchDirection } = await moduleAt('src/shared/touchDirection.ts')
const { visibleViewport } = await moduleAt('src/shared/visibleViewport.ts')
const { matchesTrackSearch } = await moduleAt('src/shared/ListSearch.tsx')
test('a playing intention at zero does not manufacture progress; extrapolation is bounded after actual advancement', () => {
  const clock = createNativeClock()
  clock.update({ id:'a', revision:1, position:0, status:'playing' }, 0)
  assert.equal(clock.position(400), 0)
  clock.update({ id:'a', revision:1, position:0, status:'playing' }, 500)
  assert.equal(clock.position(900), 0)
  clock.update({ id:'a', revision:1, position:.5, status:'playing' }, 1000)
  assert.equal(clock.position(1250), .75)
  assert.equal(clock.position(10000), 1.15)
  clock.update({ id:'a', revision:1, position:60, status:'playing' }, 1500)
  assert.equal(clock.position(1700), 60, 'a seek is not proof of a running clock')
  clock.update({ id:'b', revision:2, position:0, status:'playing' }, 2000)
  assert.equal(clock.position(2400), 0)
  clock.update({ id:'b', revision:2, position:10, status:'paused' }, 2500)
  assert.equal(clock.position(5000), 10)
})
test('keyboard viewport handles iOS visual shrinking, Android resize, native overlay and panning once', () => {
  assert.deepEqual(visibleViewport(800,500,0,800,300,true), {top:0,height:500,overlap:300,keyboardOpen:true})
  assert.deepEqual(visibleViewport(500,500,0,800,300,true), {top:0,height:500,overlap:0,keyboardOpen:true})
  assert.deepEqual(visibleViewport(800,800,0,800,300,true), {top:0,height:500,overlap:300,keyboardOpen:true})
  assert.deepEqual(visibleViewport(800,500,40,800,0,true), {top:40,height:500,overlap:300,keyboardOpen:true})
  assert.deepEqual(visibleViewport(447,447,397,844,397,true), {top:397,height:447,overlap:0,keyboardOpen:true}, 'WebKit panning is an origin change, never a second height subtraction')
  assert.deepEqual(visibleViewport(844,844,0,844,397,false), {top:0,height:447,overlap:397,keyboardOpen:true}, 'blur while choosing emotes must retain the native inset until the keyboard closes')
  assert.equal(visibleViewport(800,800,0,800,0,false).keyboardOpen,false)
})
test('gesture ownership locks to its first clear direction and protects edge navigation', () => {
  assert.equal(touchDirection(18,102,10,100),'pending')
  assert.equal(touchDirection(80,115,10,100),'edge')
  assert.equal(touchDirection(85,200,10,100,'edge'),'edge')
  assert.equal(touchDirection(150,102,100,100),'horizontal')
  assert.equal(touchDirection(104,130,100,100),'vertical')
})
test('current-list search combines title artist album uploader and BV across words and normalized text', () => {
  const track = { title:'夜曲',artist:'周杰伦',album:'十一月的萧邦',source:{uploaderName:'音乐精选',bvid:'BV1abc'} }
  assert.ok(matchesTrackSearch(track,'周杰伦 夜曲'))
  assert.ok(matchesTrackSearch(track,'bv1ABC'))
  assert.ok(matchesTrackSearch(track,'音乐精选 萧邦'))
  assert.equal(matchesTrackSearch(track,'晴天'),false)
  assert.ok(matchesTrackSearch(track,' '))
})
const { playlistCapabilities } = await moduleAt('src/features/library/playlistSelection.ts')
const { parseEmotePackages, insertCommentEmote } = await moduleAt('src/features/comments/emotes.ts')
test('playlist destinations distinguish whole multipage videos from selected parts, including mixed batches', () => {
  const video = {kind:'video',bvid:'BVmulti',title:'多 P'}
  const part = {kind:'track',track:{id:'part',partCount:2,source:{provider:'bilibili',bvid:'BVmulti'}}}
  const single = {kind:'track',track:{id:'single',partCount:1,source:{provider:'bilibili',bvid:'BVsingle'}}}
  const local = {kind:'track',track:{id:'file',source:{provider:'local'}}}
  assert.deepEqual(playlistCapabilities({items:[video]},{BVmulti:2}),{local:false,linked:true})
  assert.deepEqual(playlistCapabilities({items:[part]},{BVmulti:2}),{local:true,linked:false})
  assert.deepEqual(playlistCapabilities({items:[single]},{}),{local:true,linked:true})
  assert.deepEqual(playlistCapabilities({items:[local]},{}),{local:true,linked:false})
  assert.deepEqual(playlistCapabilities({items:[video,part]},{BVmulti:2}),{local:false,linked:false})
  assert.deepEqual(playlistCapabilities({items:[video,single]},{BVmulti:2}),{local:false,linked:true})
  assert.deepEqual(playlistCapabilities({items:[]},{}),{local:false,linked:false})
})
test('comment emotes honor explicit locks and insert at cursor without splitting Unicode or losing a selection', () => {
  const packs = parseEmotePackages({packages:[{id:4,text:'默认',emote:[{text:'[笑]',url:'http://i0.hdslb.com/a.png'},{text:'[会员]',flags:{unlocked:0}}]},{id:5,flags:{unlocked:false},emote:[{text:'[锁定]'}]}]})
  assert.equal(packs.length,1)
  assert.deepEqual(packs[0].emotes,[{text:'[笑]',url:'https://i0.hdslb.com/a.png'}])
  assert.deepEqual(insertCommentEmote('你好朋友','[笑]',2,4),{message:'你好[笑]',cursor:5})
  assert.ok(insertCommentEmote('😀','[笑]',2,2,4))
  assert.equal(insertCommentEmote('😀','[笑]',2,2,3),undefined)
})
const { parseLrc } = await moduleAt('src/features/lyrics/lrc.ts')
const { storedLyricLines, lyricAt, systemLrc } = await moduleAt('src/features/lyrics/lyricTimeline.ts')
test('enhanced lyrics preserve exact word times, Unicode and instrumental gaps through storage and bias', () => {
  const raw='[00:01.000]<00:01.000>你😀<00:01.500><00:01.700>好<00:02.000>\n[00:04.000]下一句'
  const lines=parseLrc(raw)
  assert.equal(lines[0].text,'你😀好')
  assert.deepEqual(lines[0].words,[{text:'你😀',startTimeMs:1000,endTimeMs:1500},{text:'好',startTimeMs:1700,endTimeMs:2000}])
  assert.equal(lyricAt(lines,999),-1)
  assert.equal(lyricAt(lines,1800),0)
  assert.equal(lyricAt(lines,2500),0)
  assert.equal(lyricAt(lines,2500,false),-1)
  assert.equal(lyricAt(lines,4000),1)
  assert.deepEqual(storedLyricLines({rawText:raw,parsedJson:JSON.stringify(lines)}),lines.map(line=>({...line,words:line.words})))
  assert.equal(systemLrc(lines,500),'[00:01.500]你😀好\n[00:04.500]下一句')
  assert.equal(parseLrc('[00:01.000]<00:02.000>错序<00:01.000>')[0].words,undefined)
  assert.equal(parseLrc('[00:01.000]普通歌词')[0].words,undefined)
})

test('zero-duration spacing does not discard real word timing and the current lyric holds until the next line',()=>{
 const raw='[01:31.585]<01:31.585>哦<01:34.673> <01:34.673>我<01:34.977><01:34.977>不<01:35.329><01:35.329>明<01:35.665><01:35.665>白<01:36.497>\n[01:40.000]下一句'
 const lines=parseLrc(raw)
 assert.equal(lines[0].words.length,5)
 assert.equal(lines[0].words[0].text,'哦 ')
 assert.equal(lines[0].words[1].startTimeMs,94673)
 assert.equal(lyricAt(lines,98000),0)
 assert.equal(lyricAt(lines,100000),1)
 const old=lines.map(({words,...line})=>line)
 assert.equal(storedLyricLines({rawText:raw,parsedJson:JSON.stringify(old)})[0].words.length,5,'existing saved lyrics recover without rematching')
})
test('built-in comment emotes remain available when the API uses purchase flags; custom packs still honor locks',()=>{
 const packs=parseEmotePackages({packages:[{id:1,text:'小黄脸',emote:[{text:'[笑哭]',flags:{unlocked:false,no_access:true}}]},{id:2,text:'小电视',emote:[{text:'[tv_doge]',flags:{unlocked:false}}]},{id:123,flags:{unlocked:false},emote:[{text:'[会员]'}]}]})
 assert.deepEqual(packs.map(pack=>pack.id),['1','2'])
 assert.equal(packs[0].emotes[0].text,'[笑哭]')
})
