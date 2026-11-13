import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const built=await build({entryPoints:['src/features/player/nativeAudio.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'ipc',setup(b){b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'ipc',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const invoke=(...args)=>globalThis.mediaIPC(...args);export const addPluginListener=()=>{throw new Error("unexpected listener")};'}))}}]})
const m={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
async function setup(){let receive;const events=[];const audio=m.exports.createNativeAudio('android-player',cb=>{receive=cb;return Promise.resolve()});await audio.observe(s=>events.push(s));return{audio,events,receive:s=>receive(s)}}
test('notification and headset action-only events survive newer state revisions without replacing the playback clock',async()=>{
 const h=await setup();const sample={id:'a',revision:50,sequence:8,status:'playing',position:12};h.receive(sample)
 for(const action of ['next','previous','ended','resume'])h.receive({action})
 assert.deepEqual(h.events.slice(1).map(s=>s.action),['next','previous','ended','resume'])
 globalThis.mediaIPC=async()=>({id:'old',revision:49,status:'paused',position:0})
 assert.deepEqual(await h.audio.snapshot(),sample)
 assert.equal(h.audio.playbackClock(),12)
})
test('stamped commands from an older native session are ignored, and commands do not advance the state sequence',async()=>{
 const h=await setup();h.receive({id:'a',revision:2,sequence:5,status:'playing',position:10})
 h.receive({id:'old',revision:1,sequence:100,action:'next'})
 assert.equal(h.events.length,1)
 h.receive({id:'a',revision:2,sequence:6,action:'next'});assert.equal(h.events.at(-1).action,'next')
 h.receive({id:'a',revision:2,sequence:6,status:'playing',position:10.5})
 assert.equal(h.events.at(-1).position,10.5)
 h.receive({id:'a',revision:2,sequence:4,status:'paused',position:0})
 assert.equal(h.events.at(-1).position,10.5)
})
