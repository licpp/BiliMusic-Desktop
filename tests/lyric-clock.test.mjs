import{test}from'node:test';import assert from'node:assert/strict';import{build}from'esbuild'
async function moduleAt(path){const result=await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'node'});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)}
const{createLyricClock}=await moduleAt('src/features/lyrics/lyricClock.ts')
test('lyric rendering interpolates between samples without recoiling at each message',()=>{
 const clock=createLyricClock();clock.update({id:'a',position:10,playing:true,rate:1},0)
 assert.equal(clock.position(100),10,'playing intention alone cannot advance lyrics')
 clock.update({id:'a',position:10.25,playing:true,rate:1},250)
 const before=clock.position(499);assert.equal(before,10.499)
 clock.update({id:'a',position:10.48,playing:true,rate:1},500)
 assert.ok(clock.position(500)>=before,'small media quantization does not move the highlight backwards')
 const values=Array.from({length:8},(_,i)=>clock.position(500+i*16.667));assert.equal(new Set(values).size,8)
 assert.ok(clock.position(5000)<11.3,'stale samples have a bounded interpolation horizon')
})
test('lyric clock follows pauses, seeks, rate changes and track changes immediately',()=>{
 const clock=createLyricClock();clock.update({id:'a',position:1,playing:true,rate:1},0);clock.update({id:'a',position:1.25,playing:true,rate:1},250)
 clock.update({id:'a',position:1.3,playing:false,rate:1},300);assert.equal(clock.position(1000),1.3)
 clock.update({id:'a',position:20,playing:true,rate:2,revision:1},1100);assert.equal(clock.position(1150),20)
 clock.update({id:'a',position:20.5,playing:true,rate:2,revision:1},1350);assert.equal(clock.position(1450),20.7)
 clock.update({id:'a',position:5,playing:true,rate:1,revision:2},1500);assert.equal(clock.position(1550),5)
 clock.update({id:'b',position:0,playing:true,rate:1},1600);assert.equal(clock.position(1650),0)
})
const{wordProgress}=await moduleAt('src/features/lyrics/WordLyric.tsx')
test('word fill uses fractional frame positions and remains filled after a word ends',()=>{
 assert.equal(wordProgress(1000,1200,900),'0%');assert.equal(wordProgress(1000,1200,1050),'25%');assert.equal(wordProgress(1000,1200,1066),'33%');assert.equal(wordProgress(1000,1200,1300),'100%')
})
globalThis.window={addEventListener(){}}
const{readFloatingPreferences}=await moduleAt('src/services/floatingLyricsPreferences.ts')
test('existing lyric settings migrate with colors and invalid color input falls back safely',()=>{
 assert.deepEqual(readFloatingPreferences('{"fontSize":32,"locked":true}'),{fontSize:32,locked:true,activeColor:'#b4f3e9',inactiveColor:'#91a6b5'})
 const value=readFloatingPreferences('{"fontSize":100,"activeColor":"#AABBCC","inactiveColor":"url(x)"}');assert.equal(value.fontSize,48);assert.equal(value.activeColor,'#aabbcc');assert.equal(value.inactiveColor,'#91a6b5')
})
