import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const mock = {
 platform: 'export const isMobile=true,isIOS=false,isAndroid=false,isOHOS=false;',
 mobile: `export const observeMobileAudio=async callback=>{globalThis.fixture.receive=callback};export const snapshotMobileAudio=async()=>({});export const mobilePlaybackClock=()=>0;export const setMobileCollection=async()=>{};export const prepareMobileAudio=async()=>{};export const playMobileAudio=async(...args)=>{globalThis.fixture.starts??=[];globalThis.fixture.starts.push(args);globalThis.fixture.receive({id:args[0].id,status:'playing',position:0})};export const controlMobileAudio=(action,value)=>globalThis.fixture.control(action,value);`,
 ios: 'export const iosListenerAge=()=>0;export const playIOSAudio=async()=>{};export const restartIOSAudioObservation=async()=>{};export const syncIOSQueue=async()=>{};',
 android: 'export const syncAndroidQueue=async()=>{};',
 api: 'export const inDesktopShell=true;export const getTrackPlaybackUrl=async()=>"url";export const getTrackPlaybackPlan=async()=>{await globalThis.fixture.plan?.();return {url:"url"}};export const recordPlayedTrack=async track=>track;export const getVideoParts=async()=>({parts:[]});',
 positions:'export const playbackPositionScope=async()=>undefined;export const readPlaybackPosition=async()=>globalThis.fixture.checkpoint??0;export const writePlaybackPosition=async()=>{};export const usablePlaybackPosition=p=>p;',
 media:'export const videoDetailFromTrack=()=>({parts:[]});',pages:'export const getVideoPages=async()=>[];',demo:'export const demoTracks=[];',
}
const patterns=[[/services\/platform$/,'platform'],[/\/mobileAudio$/,'mobile'],[/\/iosAudio$/,'ios'],[/\/androidAudio$/,'android'],[/services\/desktopApi$/,'api'],[/\/playbackPosition$/,'positions'],[/services\/mediaSources$/,'media'],[/services\/videoPages$/,'pages'],[/library\/demoTracks$/,'demo']]
const output=await build({entryPoints:['src/features/player/playerStore.ts'],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'audit-boundaries',setup(b){for(const[filter,path]of patterns)b.onResolve({filter},()=>({path,namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:mock[path]}))}}]})
globalThis.window=Object.assign(new EventTarget(),{setInterval:()=>0,setTimeout,clearTimeout});globalThis.document=Object.assign(new EventTarget(),{hidden:false});globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}};globalThis.sessionStorage={removeItem(){}};globalThis.fixture={control:async()=>{}};
const m={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
const store=m.exports.usePlayerStore;await new Promise(setImmediate)
const a={id:'a',title:'A',durationSeconds:100,source:{provider:'bilibili',bvid:'BV1',cid:1,page:1},liked:false};const b={...a,id:'b',title:'B',source:{...a.source,cid:2}}
test('old playback failure cannot roll back a newer play; clicking a paused current row resumes', async () => {
await store.getState().play(a);store.setState({status:'paused'});
let rejectResume;fixture.control=action=>action==='resume'?new Promise((_,reject)=>{rejectResume=reject}):Promise.resolve();
const resume=store.getState().toggle();
await store.getState().play(b);
assert.equal(store.getState().current.id,'b');assert.equal(store.getState().status,'playing');
rejectResume('old A resume failed');await resume;
console.log(JSON.stringify({current:store.getState().current.id,status:store.getState().status,error:store.getState().error},null,2));
assert.equal(store.getState().current.id,'b');assert.equal(store.getState().status,'playing');

fixture.control=async()=>{};store.setState({status:'paused'});
await store.getState().playFromList([b],b.id);
console.log(JSON.stringify({clickPausedCurrent:{current:store.getState().current.id,status:store.getState().status}},null,2));
assert.equal(store.getState().status,'playing');

})

test('A to B to A rejects a failed transport from the first A', async () => {
 fixture.control=async()=>{}
 await store.getState().play(a)
 store.setState({status:'paused'})
 let reject
 fixture.control=action=>action==='resume'?new Promise((_,r)=>{reject=r}):Promise.resolve()
 const pending=store.getState().toggle()
 await store.getState().play(b)
 await store.getState().play(a)
 reject(new Error('first A failed'))
 await pending
 assert.equal(store.getState().current.id,'a')
 assert.equal(store.getState().status,'playing')
 assert.equal(store.getState().error,null)
})

test('repeated native snapshots preserve the first diagnostic and allow dismissal until a new failure', async () => {
  fixture.control = async () => {}
  await store.getState().play(a)
  const failed = { id: a.id, engineInstanceId: 'harmony', sessionId: 'failed-a', sourceRevision: 1,
    status: 'error', recoveryAttempted: true, error: '音频加载失败', errorCode: 'ohos_media:5400106' }
  fixture.receive(failed)
  const issue = store.getState().error
  assert.equal(issue.code, failed.errorCode)
  fixture.receive({ ...failed, sequence: 2 })
  assert.strictEqual(store.getState().error, issue)
  store.setState({ error: null })
  fixture.receive({ ...failed, sequence: 3 })
  assert.equal(store.getState().error, null)
  fixture.receive({ ...failed, sourceRevision: 2 })
  assert.equal(store.getState().error.code, failed.errorCode)
})

test('new pause supersedes pending resume without progress or queue updates cancelling controls', async () => {
 fixture.control=async()=>{}
 await store.getState().play(b)
 store.setState({status:'paused'})
 let reject
 fixture.control=action=>action==='resume'?new Promise((_,r)=>{reject=r}):Promise.resolve()
 const pending=store.getState().toggle()
 store.setState({progressSeconds:5})
 store.getState().reverseQueue()
 await store.getState().toggle()
 reject(new Error('late resume'))
 await pending
 assert.equal(store.getState().status,'paused')
 assert.equal(store.getState().error,null)
})


test('disabled resume survives persistence and reaches native playback for multipart queues; explicit continue remains allowed', async () => {
 fixture.control=async()=>{};fixture.checkpoint=85
 const restored=store.persist.getOptions().merge({resumeThresholdSeconds:null},store.getState())
 assert.equal(restored.resumeThresholdSeconds,null)
 store.getState().setResumeThreshold(null)
 const first={...a,id:'multi:1',partCount:2},second={...b,id:'multi:2',partCount:2}
 await store.getState().playFromList([first,second],first.id,{kind:'video',collectionRef:'BV1'})
 const automatic=fixture.starts.at(-1)
 assert.equal(automatic[2],85)
 assert.deepEqual(automatic[9],{enabled:false,thresholdSeconds:0,collection:true,durationSeconds:100})
 await store.getState().play(second,42)
 assert.equal(fixture.starts.at(-1)[2],42)
 assert.equal(fixture.starts.at(-1)[9],undefined)
 fixture.checkpoint=0
})

test('disabling resume during URL resolution uses the latest setting at native handoff', async () => {
 fixture.checkpoint=85
 store.getState().setResumeThreshold(0)
 let resolvePlan,entered
 const waiting=new Promise(r=>{entered=r})
 fixture.plan=()=>{entered();return new Promise(r=>{resolvePlan=r})}
 const pending=store.getState().play({...a,id:'resolving-policy'})
 await waiting
 store.getState().setResumeThreshold(null)
 resolvePlan();await pending
 assert.equal(fixture.starts.at(-1)[9].enabled,false)
 fixture.plan=undefined;fixture.checkpoint=0
})
