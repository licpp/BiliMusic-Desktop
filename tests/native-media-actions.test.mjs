import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const built=await build({entryPoints:['src/features/player/nativeAudio.ts','src/features/player/iosAudio.ts'],outdir:'out',bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'ipc',setup(b){b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'ipc',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const invoke=(...args)=>globalThis.mediaIPC(...args);export const addPluginListener=()=>{throw new Error("unexpected listener")};'}))}}]})
function load(name) {
 const m={exports:{}}
 const file=built.outputFiles.find(file=>file.path.endsWith(`/${name}.js`))
 new Function('require','module','exports',file.text)(createRequire(import.meta.url),m,m.exports)
 return m.exports
}
const {createNativeAudio}=load('nativeAudio')
async function setup(){let receive;const events=[];const audio=createNativeAudio('android-player',cb=>{receive=cb;return Promise.resolve()});await audio.observe(s=>events.push(s));return{audio,events,receive:s=>receive(s)}}
test('notification and headset action-only events survive newer state revisions without replacing the playback clock',async()=>{
 const h=await setup();const sample={id:'a',revision:50,sequence:8,status:'playing',position:12};h.receive(sample)
 for(const action of ['next','previous','ended','resume'])h.receive({action})
 assert.deepEqual(h.events.slice(1).map(s=>s.action),['next','previous','ended','resume'])
 globalThis.mediaIPC=async()=>({id:'old',revision:49,status:'paused',position:0})
 const snapshot=await h.audio.snapshot(); for(const [key,value] of Object.entries(sample))assert.equal(snapshot[key],value); assert.equal(snapshot.engineInstanceId,'legacy')
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

test('rejected snapshots cannot replay a previously delivered navigation command',async()=>{
 const h=await setup()
 h.receive({engineInstanceId:'service',sessionId:'song',id:'a',sourceRevision:3,sequence:5,status:'playing',position:10})
 h.receive({engineInstanceId:'service',sessionId:'song',id:'a',sourceRevision:3,sequence:6,action:'next'})
 globalThis.mediaIPC=async()=>({engineInstanceId:'service',sessionId:'song',id:'a',sourceRevision:2,sequence:2,status:'playing',position:1})
 const snapshot=await h.audio.snapshot()
 assert.equal(snapshot.action,undefined)
 assert.equal(snapshot.position,10)
 assert.equal(h.events.filter(e=>e.action==='next').length,1)
})

test('Android stopped snapshot retires the destroyed engine and freezes its clock', async () => {
 const h = await setup()
 const paused = { engineInstanceId: 'old-service', sessionId: 'session', id: 'a', sequence: 3, status: 'paused', position: 35 }
 h.receive(paused)
 globalThis.mediaIPC = async () => ({ stopped: true })
 const snapshot = await h.audio.snapshot()
 assert.equal(snapshot.stopped, true)
 assert.equal(snapshot.id, undefined)
 assert.equal(h.audio.playbackClock(), 35)
 h.receive({ ...paused, sequence: 4 })
 assert.equal(h.events.length, 1)
 h.receive({ engineInstanceId: 'new-service', sessionId: 'new-session', id: 'a', sequence: 1, status: 'playing', position: 35 })
 assert.equal(h.events.at(-1).engineInstanceId, 'new-service')
})

test('a delayed stopped snapshot cannot retire a replacement Android service', async () => {
 const h = await setup()
 h.receive({ engineInstanceId: 'old-service', sessionId: 'old', id: 'a', status: 'paused' })
 let reply
 globalThis.mediaIPC = () => new Promise(resolve => { reply = resolve })
 const snapshot = h.audio.snapshot()
 h.receive({ engineInstanceId: 'new-service', sessionId: 'new', id: 'a', status: 'playing' })
 reply({ stopped: true })
 assert.equal((await snapshot).engineInstanceId, 'new-service')
})

test('mobile playback publishes track metadata during preparation and carries it into playback',async()=>{
 const calls=[]
 globalThis.mediaIPC=async(command, payload)=>calls.push({command,payload})
 const track={id:'bilibili:BVTEST00001:1',title:'歌曲',artist:'歌手',album:'专辑',coverUrl:'https://example.test/song.jpg',durationSeconds:180,liked:false,
  source:{provider:'bilibili',bvid:'BVTEST00001',cid:1,page:1}}
 const url='http://127.0.0.1:43122/audio'
 for(const plugin of ['android-player','ohos-player']){
  const audio=createNativeAudio(plugin)
  await audio.prepare(track)
  await audio.play(track,url,0,.7)
  const [prepare,play]=calls.splice(0)
  assert.equal(prepare.command,`plugin:${plugin}|control`)
  assert.equal(prepare.payload.action,'prepare')
  assert.equal(play.command,`plugin:${plugin}|play`)
  for(const {payload} of [prepare,play]){
   for(const field of ['id','title','artist','album','coverUrl','durationSeconds'])assert.equal(payload[field],track[field])
  }
 }
 const {prepareIOSAudio,playIOSAudio}=load('iosAudio')
 await prepareIOSAudio(track)
 await playIOSAudio(track,url,0,.7)
 assert.deepEqual(calls.map(({command,payload})=>[command,payload.id,payload.track]),[
  ['plugin:ios-player|control',track.id,track],['plugin:ios-player|play',track.id,track],
 ])
})
