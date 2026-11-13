import{test}from'node:test';import assert from'node:assert/strict';import{build}from'esbuild'
const r=await build({entryPoints:['src/features/player/sourceSwitch.ts'],bundle:true,write:false,format:'esm',platform:'node'});const{prepareAudioSource}=await import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)
class FakeAudio extends EventTarget{static last;constructor(){super();this.readyState=0;this.seeking=false;FakeAudio.last=this}load(){}pause(){this.paused=true}removeAttribute(){this.src=''}set currentTime(v){this.position=v;this.seeking=true}get currentTime(){return this.position||0}metadata(){this.readyState=1;this.dispatchEvent(new Event('loadedmetadata'))}ready(){this.seeking=false;this.readyState=3;this.dispatchEvent(new Event('canplay'))}}
globalThis.Audio=FakeAudio
const tick=()=>new Promise(setImmediate)
test('source preparation stays silent, waits for playable data and catches up with the original clock',async()=>{
 let clock=10,settled=false;const pending=prepareAudioSource('local',()=>clock,()=>true,1.5).then(value=>{settled=true;return value}),candidate=FakeAudio.last
 assert.equal(candidate.muted,true);assert.equal(candidate.volume,0)
 candidate.metadata();await tick();assert.equal(candidate.currentTime,10);assert.equal(settled,false)
 clock=12;candidate.ready();await tick();assert.equal(candidate.currentTime,12);assert.equal(settled,false)
 candidate.ready();assert.equal(await pending,candidate);assert.equal(candidate.playbackRate,1.5)
})
test('preparation failures and cancelled requests dispose the candidate without touching an original player',async()=>{
 const failed=prepareAudioSource('bad',()=>10,()=>true,1),candidate=FakeAudio.last;candidate.dispatchEvent(new Event('error'));await assert.rejects(failed,/保留原音质/);assert.equal(candidate.src,'');assert.equal(candidate.paused,true)
 let valid=true;const pending=prepareAudioSource('late',()=>10,()=>valid,1),late=FakeAudio.last;valid=false;late.metadata();await assert.rejects(pending,/已取消/);assert.equal(late.src,'')
})
