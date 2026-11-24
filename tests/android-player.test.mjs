import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const output = await build({
  entryPoints: ['src/features/player/playerStore.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['zustand', 'zustand/middleware'],
  plugins: [{name:'visibility-boundary',setup(b){
    b.onResolve({filter:/services\/contentVisibility$/},()=>({path:'visibility',namespace:'visibility-test'}))
    b.onLoad({filter:/.*/,namespace:'visibility-test'},()=>({contents:`import {create} from 'zustand'; export const useContentVisibility=create(()=>({session:'test-session',rules:[]})); export const ensureVisibility=async()=>{};`}))
  }},{ name: 'android-boundary', setup(b) {
    b.onResolve({ filter: /services\/desktopApi$/ }, () => ({ path: 'api', namespace: 'mock' }))
    b.onResolve({ filter: /services\/platform$/ }, () => ({ path: 'platform', namespace: 'mock' }))
    b.onResolve({ filter: /\.\/androidAudio$/ }, () => ({ path: 'audio', namespace: 'mock' }))
    b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'api' ? `
      export const inDesktopShell = true;
      export const recordPlayedTrack = async t => t;
      export const getVideoParts = async () => ({ parts: [] });
      export const getTrackPlaybackUrl = t => globalThis.nativeTest.resolve(t);
      export const getTrackPlaybackPlan = async (t,r) => globalThis.iosTest?.plan ? globalThis.iosTest.plan(t,r) : ({url:await getTrackPlaybackUrl(t,r)});
    ` : path === 'platform' ? 'export const isOHOS = false; export const isAndroid = true; export const isMobile = true; export const isIOS = false' : `
      export const syncAndroidQueue = async (...args) => globalThis.nativeTest.queues.push(args);
      export const setAndroidCollection = async () => {};
      export const observeAndroidAudio = cb => { globalThis.nativeTest.event = state => { globalThis.nativeTest.state = state; cb(state) }; return Promise.resolve() };
      export const snapshotAndroidAudio = async () => globalThis.nativeTest.snapshot ? globalThis.nativeTest.snapshot() : globalThis.nativeTest.state || ({});
      export const androidPlaybackClock = () => 0;
      export const controlAndroidAudio = async (...args) => {
        globalThis.nativeTest.controls.push(args);
        await globalThis.nativeTest.control?.(...args);
      };
      export const prepareAndroidAudio = async t => globalThis.nativeTest.controls.push(['prepare', t.id]);
      export const playAndroidAudio = async (...args) => globalThis.nativeTest.plays.push(args);
    ` }))
  } }],
})
function setup() {
  const listeners = {}
  const events = []
  globalThis.window = { addEventListener(type, callback) { listeners[type] = callback }, dispatchEvent(event) { events.push(event.type) }, setInterval: () => 0 }
  globalThis.document = { addEventListener() {} }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.Audio = class { constructor() { throw new Error('Android must not create WebView audio') } }
  globalThis.nativeTest = { controls: [], plays: [], queues: [], listeners, events, resolve: async t => `http://127.0.0.1:1234/token/${t.id}` }
  const m = { exports: {} }; new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), m, m.exports)
  return m.exports.usePlayerStore
}
const track = { id: 'bilibili:BV123:1', title: '歌曲', artist: '歌手', durationSeconds: 120, source: { bvid: 'BV123', cid: 1, page: 1 } }
test('Android resumes the same queue entry from its paused position after the native service was destroyed', async () => {
  const store = setup()
  const second = { ...track, id: 'bilibili:BV123:2', source: { ...track.source, cid: 2, page: 2 } }
  await store.getState().playFromList([track, second], track.id)
  nativeTest.event({ id: track.id, status: 'playing', position: 34 })
  nativeTest.event({ id: track.id, status: 'paused', position: 35 })
  nativeTest.control = async action => {
    if (action === 'resume') throw { code: 'native_not_ready' }
  }
  nativeTest.state = { stopped: true }
  const statuses = []
  store.subscribe(state => statuses.push(state.status))

  await store.getState().toggle()

  assert.equal(nativeTest.plays.length, 2)
  assert.equal(nativeTest.plays[1][0].id, track.id)
  assert.equal(nativeTest.plays[1][2], 35)
  assert.deepEqual(store.getState().queue.map(item => item.id), [track.id, second.id])
  assert.ok(!statuses.includes('playing'))
  nativeTest.event({ id: track.id, status: 'playing', position: 36 })
  assert.equal(store.getState().status, 'playing')
})

test('Android waits for the native service to confirm resume without reloading an existing source', async () => {
  const store = setup()
  await store.getState().play(track)
  nativeTest.event({ id: track.id, status: 'playing', position: 33 })
  nativeTest.event({ id: track.id, status: 'paused', position: 34 })
  await store.getState().toggle()
  assert.equal(store.getState().status, 'buffering')
  nativeTest.event({ id: track.id, status: 'playing', position: 35 })
  assert.equal(store.getState().status, 'playing')
  assert.equal(nativeTest.plays.length, 1)
})

test('Android retains the paused position when returning to the app detects the stopped service', async () => {
  const store = setup()
  await store.getState().play(track)
  nativeTest.event({ id: track.id, status: 'playing', position: 34 })
  nativeTest.event({ id: track.id, status: 'paused', position: 35 })
  nativeTest.state = { stopped: true }
  nativeTest.listeners.focus()
  await new Promise(resolve => setImmediate(resolve))

  await store.getState().toggle()

  assert.equal(nativeTest.plays.length, 2)
  assert.equal(nativeTest.plays[1][2], 35)
  assert.ok(!nativeTest.controls.some(([action]) => action === 'resume'))
})

test('Android preserves a confirmed playback state when a pending foreground probe fails', async () => {
  const store = setup()
  await store.getState().play(track)
  nativeTest.event({ id: track.id, status: 'playing', position: 6 })
  let rejectProbe
  nativeTest.snapshot = () => new Promise((_, reject) => { rejectProbe = reject })
  nativeTest.listeners.focus()
  await new Promise(resolve => setImmediate(resolve))
  nativeTest.event({ id: track.id, status: 'playing', position: 7 })

  rejectProbe(new Error('bridge unavailable'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.getState().status, 'playing')
  assert.equal(store.getState().progressSeconds, 7)
  assert.equal(store.getState().error, null)
  assert.ok(!nativeTest.events.includes('bilimusic-playback-reconciled'))

  nativeTest.snapshot = async () => ({ id: track.id, status: 'playing', position: 8 })
  nativeTest.listeners.focus()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.getState().progressSeconds, 8)
  assert.equal(nativeTest.events.filter(event => event === 'bilimusic-playback-reconciled').length, 1)
  await store.getState().toggle()
  assert.equal(nativeTest.controls.at(-1)[0], 'pause')
  assert.equal(nativeTest.plays.length, 1)
})

test('Android can cancel a pending resume before a stale service error returns', async () => {
  const store = setup()
  await store.getState().play(track)
  nativeTest.event({ id: track.id, status: 'playing', position: 33 })
  nativeTest.event({ id: track.id, status: 'paused', position: 34 })
  let rejectResume
  nativeTest.control = action => action === 'resume' ? new Promise((_, reject) => { rejectResume = reject }) : undefined
  const resuming = store.getState().toggle()
  await store.getState().toggle()
  rejectResume({ code: 'native_not_ready' })
  await resuming
  assert.deepEqual(nativeTest.controls.slice(-2), [['resume'], ['pause']])
  assert.equal(store.getState().status, 'paused')
  assert.equal(store.getState().error, null)
  assert.equal(nativeTest.plays.length, 1)
})
test('Android routes playback, seek and volume to native service and accepts only current track state', async () => {
  const s = setup(); await s.getState().play(track)
  assert.equal(nativeTest.plays.length, 1)
  assert.deepEqual(nativeTest.controls[0], ['prepare', track.id])
  nativeTest.event({ id: track.id, status: 'playing', position: 12, duration: 120 })
  assert.equal(s.getState().status, 'playing')
  nativeTest.event({ id: 'old', status: 'error', error: 'stale' })
  assert.equal(s.getState().status, 'playing')
  nativeTest.state = { id: track.id, status: 'playing' }
  s.getState().seek(20); s.getState().setVolume(.3); await s.getState().toggle()
  assert.deepEqual(nativeTest.controls.slice(-3), [['seek', 20], ['volume', .3], ['pause']])
})
test('Android cancel during URL resolution prevents late native autoplay', async () => {
  const s = setup(); let resolve
  nativeTest.resolve = () => new Promise(r => { resolve = r })
  const playing = s.getState().play(track)
  while (!resolve) await Promise.resolve()
  nativeTest.event({ id: track.id, status: 'buffering', stopped: true })
  assert.equal(s.getState().status, 'resolving')
  await s.getState().toggle(); resolve('http://127.0.0.1:1234/token/late'); await playing
  assert.equal(nativeTest.plays.length, 0)
  assert.equal(s.getState().status, 'paused')
})
test('Android URL failure stops the preparing foreground service', async () => {
  const s = setup(); nativeTest.resolve = async () => { throw new Error('source unavailable') }
  await s.getState().play(track)
  assert.deepEqual(nativeTest.controls.at(-1), ['stop'])
  assert.equal(s.getState().status, 'error')
})
test('Android notification pause while resolving prevents deferred autoplay', async () => {
  const s = setup(); let resolve
  nativeTest.resolve = () => new Promise(r => { resolve = r })
  const playing = s.getState().play(track)
  while (!resolve) await Promise.resolve()
  nativeTest.event({ id: track.id, status: 'paused', stopped: true })
  resolve('http://127.0.0.1:1234/token/late'); await playing
  assert.equal(nativeTest.plays.length, 0)
  assert.equal(s.getState().status, 'paused')
})
test('Android source errors show a localized playback message', async () => {
  const s = setup(); nativeTest.resolve = async () => { throw 'source service returned HTTP 403' }
  await s.getState().play(track)
  assert.equal(s.getState().error.message, '暂时无法播放这首歌，请重试')
})

test('system navigation changes the Android queue and late commands for a previous track are ignored',async()=>{
 const store=setup(),second={...track,id:'bilibili:BV123:2',title:'第二首',source:{...track.source,cid:2,page:2}}
 await store.getState().playFromList([track,second],track.id)
 nativeTest.event({id:track.id,status:'playing',position:1,revision:50,sequence:8})
 nativeTest.event({id:track.id,revision:50,sequence:9,action:'next'})
 for(let i=0;i<15&&store.getState().current?.id!==second.id;i++)await Promise.resolve()
 assert.equal(store.getState().current.id,second.id)
 const plays=nativeTest.plays.length
 nativeTest.event({id:track.id,revision:50,sequence:10,action:'previous'})
 await Promise.resolve();assert.equal(store.getState().current.id,second.id);assert.equal(nativeTest.plays.length,plays)
})


test('Android hands queue and resume policy to its service before playback', async () => {
 const s=setup(),second={...track,id:'bilibili:BV123:2',source:{...track.source,cid:2,page:2}}
 await s.getState().playFromList([track,second],track.id)
 assert.deepEqual(nativeTest.queues.at(-1)[0].map(t=>t.id),[track.id,second.id])
 s.getState().setResumeThreshold(600);await Promise.resolve();await Promise.resolve()
 assert.equal(nativeTest.queues.at(-1)[3],600)
})
test('Android adopts native background transitions without resolving or playing twice', async () => {
 const s=setup(),second={...track,id:'bilibili:BV123:2',title:'second',source:{...track.source,cid:2,page:2}}
 await s.getState().playFromList([track,second],track.id)
 nativeTest.event({id:track.id,status:'playing',position:100,stopped:false})
 nativeTest.event({id:second.id,track:second,status:'buffering',stopped:true})
 assert.equal(s.getState().current.id,second.id)
 nativeTest.event({id:second.id,track:second,status:'playing',position:5,duration:120,stopped:false})
 assert.equal(s.getState().progressSeconds,5);assert.equal(s.getState().status,'playing')
 assert.equal(nativeTest.plays.length,1)
})
test('Android accepts expanded background collection parts and avoids a second recovery', async () => {
 const s=setup(),entry={...track,id:'entry',resolveParts:true},part={...track,id:'part2',source:{...track.source,cid:2,page:2}}
 s.setState({queue:[entry],current:entry,status:'playing'})
 nativeTest.event({id:part.id,track:part,expandedEntries:{entry:[track,part]},status:'playing',position:1,stopped:false})
 assert.deepEqual(s.getState().queue.map(t=>t.id),[track.id,part.id])
 nativeTest.event({id:part.id,track:part,status:'error',error:'音频缓冲超时，请重试',stopped:true,recoveryAttempted:true})
 assert.equal(nativeTest.plays.length,0);assert.equal(s.getState().status,'error')
})
