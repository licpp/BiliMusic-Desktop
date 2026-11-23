import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const output = await build({
  stdin: {contents:"export * from './src/features/player/playerStore'; export {useContentVisibility} from './src/services/contentVisibility'; export {indexOfflineTracks,useOfflinePlayback} from './src/features/player/offlinePlayback'; export {setLoudnessPreference,useLoudnessSettings} from './src/services/loudness'",resolveDir:process.cwd()}, bundle: true, write: false,
  format: 'cjs', platform: 'node', external: ['zustand', 'zustand/middleware'],
  plugins: [{name:'visibility-boundary',setup(b){
    b.onResolve({filter:/services\/contentVisibility$/},()=>({path:'visibility',namespace:'visibility-test'}))
    b.onLoad({filter:/.*/,namespace:'visibility-test'},()=>({contents:`import {create} from 'zustand'; export const useContentVisibility=create(()=>({session:'test-session',rules:[]})); export const ensureVisibility=async()=>{};`}))
  }},{ name: 'desktop-boundary', setup(builder) {
    builder.onResolve({ filter: /services\/desktopApi$/ }, () => ({ path: 'desktop-api', namespace: 'test' }))
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, args => /(?:^|[\\/])playbackPosition\.ts$/.test(args.importer) ? { path: 'position-api', namespace: 'test' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'test' }, ({path}) => ({ contents: path === 'position-api' ? `
      export const isTauri = () => true;
      export const invoke = async (command,args) => command === 'listening_scope' ? 'scope'
        : args.seconds === undefined ? globalThis.testApi.readPosition ? globalThis.testApi.readPosition(args.trackId) : globalThis.testApi.positions.get(args.trackId) || 0 : globalThis.testApi.writes.push(args);
    ` : `
      export const inDesktopShell = true;
      export const recordPlayedTrack = track => globalThis.testApi.record(track);
      export const getVideoParts = async () => ({ parts: [] });
      export const getTrackPlaybackUrl = (track, refresh) => globalThis.testApi.resolve(track, refresh);
      export const getTrackPlaybackPlan = async (t,r,p,o) => globalThis.testApi.plan ? globalThis.testApi.plan(t,r,p,o) : ({url:await getTrackPlaybackUrl(t,r)});
    ` }))
  } }],
})

function setup(snapshot) {
  const listeners = {}
  const audio = []
  const storage = new Map(snapshot ? [['resonance-player-v1', JSON.stringify(snapshot)]] : [])
  globalThis.window = { addEventListener: (name, callback) => { listeners[name] = callback }, dispatchEvent() {} }
  globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  globalThis.Audio = class {
    src = ''; currentTime = 0; volume = 1; callbacks = {}; plays = 0; readyState = globalThis.testApi?.readyState ?? 3; seeking = false; paused = true
    get duration() { return globalThis.testApi.mediaDuration ?? globalThis.testApi.trackDuration ?? 120 }
    constructor() { audio.push(this) }
    handlers = new Map()
    addEventListener(name, callback) { if(!this.handlers.has(name))this.handlers.set(name,new Set());this.handlers.get(name).add(callback);this.callbacks[name]=()=>{for(const fn of [...this.handlers.get(name)])fn()} }
    removeEventListener(name, callback) { this.handlers.get(name)?.delete(callback) }
    pause() { this.paused = true; this.callbacks.pause?.() }
    load() {}
    removeAttribute() { this.src = '' }
    async play() { this.paused = false; this.plays++; this.callbacks.playing?.() }
  }
  globalThis.testApi = { writes:[], positions:new Map(snapshot?.state?.current ? [[snapshot.state.current.id,snapshot.state.progressSeconds || 0]] : []), record: async track => { globalThis.testApi.trackDuration=track.durationSeconds; return track }, resolve: async track => `local://${track.id}` }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  return { store: module.exports.usePlayerStore, audio, listeners, storage, module: module.exports }
}
const track = id => ({ id, source: { provider: 'bilibili', bvid: 'BVTEST00001', cid: Number(id), page: 1 }, title: id, durationSeconds: 120, liked: false })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('desktop sleep deadline pauses an active track on wake, blocks stale ended, and can repeat', async () => {
  let now = 1_800_000_000_000
  const oldClock = Date.now
  Date.now = () => now
  try {
    const { store, audio, listeners, module } = setup()
    await store.getState().playFromList([track('1'), track('2')], '1')
    await module.controlDesktopSleep('sleepStart', 60)
    now += 60_001
    listeners.focus()
    audio[0].callbacks.ended()
    assert.equal(store.getState().current.id, '1')
    assert.equal(store.getState().status, 'paused')
    assert.equal(audio[0].paused, true)
    assert.deepEqual(store.getState().sleep, { deadline: 0, duration: 60, expired: true })
    await module.controlDesktopSleep('sleepRepeat')
    assert.equal(store.getState().status, 'playing')
    assert.equal(store.getState().sleep.deadline, now + 60_000)
    await module.controlDesktopSleep('sleepCancel')
    assert.equal(store.getState().sleep.deadline, 0)
    listeners.pagehide()
  } finally { Date.now = oldClock }
})

test('desktop sleep deadline suppresses deferred autoplay without restarting a manually paused track', async () => {
  let now = 1_800_000_000_000
  const oldClock = Date.now
  Date.now = () => now
  try {
    const { store, audio, listeners, module } = setup()
    const pending = deferred()
    const started = deferred()
    globalThis.testApi.resolve = async () => { started.resolve(); return pending.promise }
    const playing = store.getState().play(track('1'))
    await started.promise
    await module.controlDesktopSleep('sleepStart', 60)
    now += 60_001
    listeners.focus()
    pending.resolve('local://1')
    await playing
    assert.equal(store.getState().status, 'paused')
    assert.equal(audio.length, 0)
    await module.controlDesktopSleep('sleepStart', 60)
    now += 60_001
    listeners.focus()
    assert.equal(audio.length, 0)
    assert.equal(store.getState().status, 'paused')
    listeners.pagehide()
  } finally { Date.now = oldClock }
})

test('rapid switching discards stale source responses', async () => {
  const { store, audio, listeners } = setup()
  const old = deferred()
  globalThis.testApi.resolve = async value => value.id === '1' ? old.promise : 'local://2'
  const first = store.getState().play(track('1'))
  await Promise.resolve()
  await store.getState().play(track('2'))
  old.resolve('local://1'); await first
  assert.equal(store.getState().current.id, '2')
  assert.equal(audio[0].src, 'local://2')
  assert.equal(audio[0].plays, 1)
  listeners.pagehide()
})

test('pause while resolving cancels pending autoplay and resumes correct track', async () => {
  const { store, audio, listeners } = setup()
  const pending = deferred()
  globalThis.testApi.resolve = () => pending.promise
  const playing = store.getState().play(track('1'))
  await Promise.resolve()
  await store.getState().toggle()
  pending.resolve('local://1'); await playing
  assert.equal(store.getState().status, 'paused')
  assert.equal(audio[0].plays, 0)
  globalThis.testApi.resolve = async () => 'local://1'
  await store.getState().toggle()
  assert.equal(audio[0].src, 'local://1')
  assert.equal(store.getState().status, 'playing')
  listeners.pagehide()
})

test('queue operations preserve stable identities and synchronize metadata', () => {
  const { store, listeners } = setup()
  store.getState().enqueue([track('1'), track('2'), track('1')])
  assert.deepEqual(store.getState().queue.map(t => t.id), ['1', '2'])
  store.getState().moveInQueue('2', -1)
  store.getState().updateTrack({ ...track('2'), artist: '歌手' })
  assert.equal(store.getState().queue[0].artist, '歌手')
  store.getState().removeFromQueue('1')
  assert.equal(store.getState().queue.length, 1)
  store.getState().clearQueue()
  assert.equal(store.getState().queue.length, 0)
  listeners.pagehide()
})

test('restart restores queue, position and volume without autoplay', async () => {
  const { store, audio, listeners } = setup({ state: { current: track('1'), queue: [track('1')], progressSeconds: 32, durationSeconds: 120, volume: .25, repeatMode: 'all', shuffled: false }, version: 0 })
  assert.equal(store.getState().status, 'paused')
  assert.equal(audio.length, 0)
  await store.getState().toggle()
  assert.equal(audio[0].currentTime, 32)
  assert.equal(audio[0].volume, .25)
  listeners.pagehide()
})

test('a comment seek while audio is unloaded overrides the saved checkpoint only for the current track', async () => {
  const restore = { state: { current: track('1'), queue: [track('1')], progressSeconds: 12, durationSeconds: 120 }, version: 0 }
  const first = setup(restore)
  first.store.getState().seek(82)
  await first.store.getState().toggle()
  assert.equal(first.audio[0].currentTime, 82)
  first.listeners.pagehide()
  const another = setup(restore)
  another.store.getState().seek(82)
  await another.store.getState().play(track('2'))
  assert.equal(another.audio[0].currentTime, 0)
  another.listeners.pagehide()
})

test('restored Bilibili covers use HTTPS allowed by the desktop CSP', () => {
  const input = { ...track('1'), coverUrl: 'http://i0.hdslb.com/cover.jpg' }
  const { store, listeners } = setup({ state: { current: input, queue: [input] }, version: 0 })
  assert.equal(store.getState().current.coverUrl, 'https://i0.hdslb.com/cover.jpg')
  assert.equal(store.getState().queue[0].coverUrl, 'https://i0.hdslb.com/cover.jpg')
  listeners.pagehide()
})

test('one playback mode control cycles mutually exclusive modes and persists them', async () => {
  const { store, listeners, storage } = setup()
  const modes = []
  for (let i=0;i<4;i++) {
    store.getState().cyclePlaybackMode()
    modes.push([store.getState().shuffled,store.getState().repeatMode])
  }
  assert.deepEqual(modes, [[false,'all'],[false,'one'],[true,'all'],[false,'off']])
  store.getState().cyclePlaybackMode(); store.getState().cyclePlaybackMode()
  store.setState({ queue:[track('1'),track('2')],current:track('1') })
  await store.getState().next(true)
  assert.equal(store.getState().current.id,'1','single repeat must replay the same song')
  store.getState().cyclePlaybackMode()
  await store.getState().next(true)
  assert.equal(store.getState().current.id,'2','random mode must not retain single-repeat behavior')
  listeners.pagehide()
  const restored=setup(JSON.parse(storage.get('resonance-player-v1')))
  assert.equal(restored.store.getState().shuffled,true)
  assert.equal(restored.store.getState().repeatMode,'all')
  restored.listeners.pagehide()
})

test('clicking a list song replaces the queue and starts at its original index', async()=>{
 const {store,listeners}=setup();store.getState().enqueue([track('9')]);
 await store.getState().playFromList([track('1'),track('2'),track('3')],'2');
 assert.deepEqual(store.getState().queue.map(t=>t.id),['1','2','3']);assert.equal(store.getState().current.id,'2');
 await store.getState().next();assert.equal(store.getState().current.id,'3');
 await store.getState().previous();assert.equal(store.getState().current.id,'2');
 await store.getState().previous();assert.equal(store.getState().current.id,'1');listeners.pagehide();
});
test('changing list during resolution cannot restore the old queue or song',async()=>{
 const {store,listeners}=setup(),pending=deferred();globalThis.testApi.record=async value=>value.id==='1'?pending.promise:value;
 const first=store.getState().playFromList([track('1'),track('2')],'1');
 await store.getState().playFromList([track('3'),track('4')],'4');pending.resolve(track('1'));await first;
 assert.equal(store.getState().current.id,'4');assert.deepEqual(store.getState().queue.map(t=>t.id),['3','4']);listeners.pagehide();
});
test('invalid list selection leaves the existing queue intact and duplicates are removed',async()=>{
 const {store,listeners}=setup();await store.getState().playFromList([track('1'),track('1'),track('2')],'2');
 assert.deepEqual(store.getState().queue.map(t=>t.id),['1','2']);
 await store.getState().playFromList([track('3')],'missing');assert.equal(store.getState().current.id,'2');assert.deepEqual(store.getState().queue.map(t=>t.id),['1','2']);listeners.pagehide();
});

test('selecting the current song in another list changes the queue without reloading audio', async () => {
  const { store, audio } = setup()
  await store.getState().playFromList([track('1'), track('2')], '2')
  audio[0].currentTime = 43
  audio[0].callbacks.timeupdate()
  await store.getState().playFromList([track('3'), track('2')], '2')
  assert.equal(audio[0].plays, 1)
  assert.ok(store.getState().queueFeedback?.serial)
  assert.equal(store.getState().progressSeconds, 43)
  assert.deepEqual(store.getState().queue.map(item => item.id), ['3', '2'])
  store.getState().reverseQueue()
  assert.deepEqual(store.getState().queue.map(item => item.id), ['2', '3'])
  assert.equal(store.getState().current.id, '2')
  assert.equal(store.getState().progressSeconds, 43)
})

test('moving a BV in the queue moves its parts together without changing the playing song', async () => {
  const { store } = setup()
  const first = { ...track('1'), source: { ...track('1').source, bvid: 'BVfirst' } }
  const second = { ...track('2'), source: { ...track('2').source, bvid: 'BVfirst', page: 2 } }
  const other = { ...track('3'), source: { ...track('3').source, bvid: 'BVother' } }
  await store.getState().playFromList([first, second, other], '2')
  store.getState().moveQueueRows(['1', '2'], 1, true)
  assert.deepEqual(store.getState().queue.map(item => item.id), ['3', '1', '2'])
  assert.equal(store.getState().current.id, '2')
  store.getState().moveQueueRows(['1'], -1, false)
  assert.deepEqual(store.getState().queue.map(item => item.id), ['3', '1', '2'])
  store.getState().removeQueueRows(['1', '2'])
  assert.deepEqual(store.getState().queue.map(item => item.id), ['3'])
})

test('transient playback connection errors retry once with a fresh source', async () => {
  const { store, audio } = setup()
  const refreshes = []
  globalThis.testApi.resolve = async (value, refresh) => {
    refreshes.push(refresh)
    if (!refresh) throw new Error('Could not connect to the server')
    return `local://${value.id}`
  }
  await store.getState().play(track('1'), 27)
  await new Promise(setImmediate)
  assert.deepEqual(refreshes, [false, true])
  assert.equal(audio[0].plays, 1)
  assert.equal(audio[0].currentTime, 27)
})

test('playback rate changes in place and carries to the next song', async () => {
  const { store, audio, listeners } = setup()
  await store.getState().playFromList([track('1'), track('2')], '1')
  audio[0].currentTime = 21
  await store.getState().setRate(1.5)
  assert.equal(audio[0].currentTime, 21)
  assert.equal(audio[0].plays, 1)
  assert.equal(audio[0].playbackRate, 1.5)
  await store.getState().next()
  assert.equal(audio[0].playbackRate, 1.5)
  assert.equal(audio[0].plays, 2)
  listeners.pagehide()
})

test('resume slider defaults to all, persists disabled, and permits explicit positions', async () => {
  const initial = setup()
  assert.equal(initial.store.getState().resumeThresholdSeconds, 0)
  initial.store.getState().setResumeThreshold(null)
  initial.listeners.pagehide()
  const saved = JSON.parse(initial.storage.get('resonance-player-v1'))
  const longTrack = { ...track('1'), durationSeconds: 720 }
  Object.assign(saved.state, { current: longTrack, queue: [longTrack], progressSeconds: 85, durationSeconds: 720 })
  const { store, audio } = setup(saved)
  assert.equal(store.getState().resumeThresholdSeconds, null)
  await store.getState().toggle()
  assert.equal(audio[0].currentTime, 0)
  await store.getState().play({ ...longTrack, id: '2' }, 85)
  assert.equal(audio[0].currentTime, 85)
})

test('retired local audio is removed from restored current track and queue without removing Bilibili songs', () => {
  const local = { ...track('legacy'), id:'local:00000000-0000-4000-8000-000000000001', source:{provider:'local'} }
  const {store,listeners} = setup({state:{current:local,queue:[local,track('1')],progressSeconds:34},version:0})
  assert.equal(store.getState().current,null)
  assert.equal(store.getState().progressSeconds,0)
  assert.equal(store.getState().durationSeconds,0)
  assert.deepEqual(store.getState().queue.map(value=>value.id),['1'])
  listeners.pagehide()
})


test('legacy resume switches migrate to the matching slider endpoints', () => {
  for (const [legacy,expected] of [[false,null],[true,0]]) {
    const {store,listeners}=setup({state:{autoResume:legacy},version:0})
    assert.equal(store.getState().resumeThresholdSeconds,expected)
    assert.equal('autoResume' in store.getState(),false)
    listeners.pagehide()
  }
})

test('restart applies the single-video threshold at the duration boundary', async () => {
  for (const duration of [599,600,601]) {
    const current={...track('1'),durationSeconds:duration}
    const {store,audio,listeners}=setup({state:{current,queue:[current],progressSeconds:85,durationSeconds:duration,resumeThresholdSeconds:600},version:0})
    await store.getState().toggle()
    assert.equal(audio[0].currentTime,duration>=600?85:0)
    listeners.pagehide()
  }
})

test('disabled automatic resume restarts multipart and collection tracks but permits explicit continuation', async () => {
  const base=track('1')
  for (const [current,queueSource] of [[{...base,partCount:2},undefined],[{...base,source:{...base.source,page:2}},undefined],[base,{kind:'season',title:'合集'}],[base,{kind:'video',title:'选集',collectionRef:'BVTEST00001'}]]) {
    const {store,audio,listeners}=setup({state:{current,queue:[current],queueSource,progressSeconds:32,durationSeconds:120,resumeThresholdSeconds:null},version:0})
    await store.getState().toggle()
    assert.equal(audio[0].currentTime,0)
    await store.getState().play(current,32)
    assert.equal(audio[0].currentTime,32)
    listeners.pagehide()
  }
})

test('threshold changes never rewind an already loaded song after pause', async () => {
  const {store,audio,listeners}=setup()
  await store.getState().play(track('1'),42)
  await store.getState().toggle()
  store.getState().setResumeThreshold(null)
  await store.getState().toggle()
  assert.equal(audio[0].currentTime,42)
  listeners.pagehide()
})

test('selecting a video applies its own duration to the saved checkpoint, while explicit collection resume bypasses the threshold', async () => {
  const {store,audio,listeners}=setup()
  store.getState().setResumeThreshold(600)
  const short={...track('1'),durationSeconds:599}
  const long={...track('2'),source:{...track('2').source,bvid:'BVother'},durationSeconds:600}
  testApi.positions.set(short.id,84);testApi.positions.set(long.id,85)
  await store.getState().play(short)
  assert.equal(audio[0].currentTime,0)
  await store.getState().play(long)
  assert.equal(audio[0].currentTime,85)
  store.getState().setResumeThreshold(null)
  await store.getState().playFromList([short],short.id,{kind:'season',title:'合集',collectionRef:'season:1'},84)
  assert.equal(audio[0].currentTime,84)
  listeners.pagehide()
})

test('desktop uses progressive startup and hands off only after the initial source advances',async()=>{
 const {store,audio,listeners}=setup();testApi.plan=async()=>({url:'local://fast',upgradeUrl:'local://high'})
 await store.getState().play(track('1'),0)
 assert.equal(audio[0].src,'local://fast');assert.equal(audio.length,1)
 audio[0].currentTime=.5;audio[0].callbacks.timeupdate();await new Promise(setImmediate);assert.equal(audio.length,1)
 audio[0].currentTime=1;audio[0].callbacks.timeupdate();await new Promise(setImmediate)
 assert.equal(audio.length,2);assert.equal(audio[1].src,'local://high');assert.equal(audio[1].currentTime,1);assert.equal(store.getState().status,'playing');assert.equal(audio[0].src,'')
 listeners.pagehide()
})
test('pausing before audible progress defers automatic desktop quality preparation',async()=>{
 const {store,audio,listeners}=setup();testApi.plan=async()=>({url:'local://fast',upgradeUrl:'local://high'})
 await store.getState().play(track('1'),0);await store.getState().toggle()
 audio[0].currentTime=2;audio[0].callbacks.timeupdate();await new Promise(setImmediate);assert.equal(audio.length,1)
 await store.getState().toggle();audio[0].callbacks.timeupdate();await new Promise(setImmediate);assert.equal(audio[1].src,'local://high');listeners.pagehide()
})

test('automatic resume compares prepared video total duration even when list metadata is missing or wrong', async () => {
 for (const [listed, actual, expected] of [[0,1800,85],[1800,300,0],[120,1800,85],[0,600,85],[1800,599,0]]) {
  const {store,audio,listeners}=setup();store.getState().setResumeThreshold(600)
  testApi.mediaDuration=actual;testApi.positions.set('1',85)
  await store.getState().play({...track('1'),durationSeconds:listed})
  assert.equal(audio[0].currentTime,expected,`listed=${listed}, total=${actual}`)
  listeners.pagehide()
 }
})

test('reopening and reselecting use the same local checkpoint instead of the persisted UI snapshot', async () => {
 for (const saved of [110,0]) {
  const current=track('1');const {store,audio,listeners}=setup({state:{current,queue:[current],progressSeconds:85,durationSeconds:120},version:0})
  testApi.positions.set(current.id,saved)
  await store.getState().toggle();assert.equal(audio[0].currentTime,saved)
  listeners.pagehide()
 }
})

test('automatic resume waits for metadata and initial seek before starting audio', async () => {
 const {store,audio,listeners}=setup();testApi.readyState=0;testApi.mediaDuration=0;testApi.positions.set('1',85);store.getState().setResumeThreshold(600)
 const playing=store.getState().play({...track('1'),durationSeconds:0});await new Promise(setImmediate)
 const element=audio[0];assert.equal(element.plays,0)
 testApi.mediaDuration=1800;element.readyState=1;element.seeking=true;element.callbacks.loadedmetadata()
 await new Promise(setImmediate);assert.equal(element.currentTime,85);assert.equal(element.plays,0)
 element.seeking=false;element.callbacks.seeked();await playing
 assert.equal(element.plays,1);assert.equal(store.getState().progressSeconds,85)
 listeners.pagehide()
})

test('pausing during metadata preparation cancels the pending automatic start', async () => {
 const {store,audio,listeners}=setup();testApi.readyState=0;testApi.positions.set('1',85)
 const playing=store.getState().play(track('1'));await new Promise(setImmediate)
 await store.getState().toggle();audio[0].readyState=1;audio[0].callbacks.loadedmetadata();await playing
 assert.equal(audio[0].plays,0);assert.equal(store.getState().status,'paused');listeners.pagehide()
})

test('retrying automatic source resolution retains the duration policy', async () => {
 const {store,audio,listeners}=setup();store.getState().setResumeThreshold(600);testApi.positions.set('1',85);testApi.mediaDuration=120
 let calls=0;testApi.plan=async()=>{if(++calls===1)throw new Error('Network error');return {url:'local://1'}}
 await store.getState().play({...track('1'),durationSeconds:1800});await new Promise(setImmediate)
 assert.equal(calls,2);assert.equal(audio[0].currentTime,0);listeners.pagehide()
})

test('a failed local checkpoint read does not silently restart and replace the saved progress', async () => {
 const {store,audio,listeners}=setup();testApi.readPosition=async()=>{throw new Error('Database busy')}
 await store.getState().play(track('1'))
 assert.equal(store.getState().status,'error');assert.equal(audio.length,0);listeners.pagehide()
})

test('pausing an initial seek never persists zero over the previous checkpoint, and retry reads it again',async()=>{
 const {store,audio,listeners}=setup();testApi.readyState=0;testApi.positions.set('1',85)
 const pending=store.getState().play(track('1'));await new Promise(setImmediate)
 await store.getState().toggle();await new Promise(setImmediate)
 assert.equal(testApi.writes.length,0)
 audio[0].readyState=1;audio[0].callbacks.loadedmetadata();await pending
 await store.getState().toggle();assert.equal(audio[0].currentTime,85);listeners.pagehide()
})

test('a duration reported after loadedmetadata is awaited rather than treating an unknown video as short',async()=>{
 const {store,audio,listeners}=setup();testApi.readyState=0;testApi.mediaDuration=0;testApi.positions.set('1',85);store.getState().setResumeThreshold(600)
 const pending=store.getState().play({...track('1'),durationSeconds:0});await new Promise(setImmediate)
 audio[0].readyState=1;audio[0].callbacks.loadedmetadata();await new Promise(setImmediate)
 assert.equal(audio[0].plays,0);testApi.mediaDuration=1800;audio[0].callbacks.loadedmetadata()
 await pending;assert.equal(audio[0].currentTime,85);listeners.pagehide()
})

test('an explicit seek while reading the local record wins over the automatic resume threshold',async()=>{
 const {store,audio,listeners}=setup();const pending=deferred();testApi.record=()=>pending.promise;store.getState().setResumeThreshold(null)
 const playing=store.getState().play(track('1'));await new Promise(setImmediate);store.getState().seek(42)
 pending.resolve(track('1'));await playing;assert.equal(audio[0].currentTime,42);listeners.pagehide()
})

test('queue replacement and reordering survive immediate termination without waiting for pagehide', async()=>{
 const {store,storage,listeners}=setup()
 const tracks=[track('801'),track('802'),track('803')]
 await store.getState().playFromList(tracks,tracks[1].id,{kind:'video',title:'我的列表'})
 let saved=JSON.parse(storage.get('resonance-player-v1')).state
 assert.deepEqual(saved.queue.map(t=>t.id),tracks.map(t=>t.id));assert.equal(saved.current.id,'802');assert.equal(saved.queueSource.title,'我的列表')
 store.getState().reverseQueue()
 saved=JSON.parse(storage.get('resonance-player-v1')).state
 assert.deepEqual(saved.queue.map(t=>t.id),['803','802','801'])
 listeners.pagehide()
})


test('desktop start observes disabled resume even when changed while metadata loads', async () => {
 const {store,audio,listeners}=setup()
 globalThis.testApi.positions.set('1',32)
 globalThis.testApi.readyState=0
 const pending=store.getState().play({...track('1'),partCount:2})
 while(!audio[0]?.src) await new Promise(setImmediate)
 store.getState().setResumeThreshold(null)
 audio[0].readyState=3;audio[0].callbacks.loadedmetadata()
 await pending
 assert.equal(audio[0].currentTime,0)
 listeners.pagehide()
})


test('collection checkpoint selects the saved track but obeys the time-resume setting and starts its UI at zero',async()=>{
 for(const [threshold,duration,expected] of [[null,1800,0],[600,120,0],[600,1800,84],[0,120,84]]){
  const {store,audio,listeners}=setup();const current={...track('1'),durationSeconds:duration}
  store.getState().setResumeThreshold(threshold)
  const resolving=deferred();globalThis.testApi.resolve=()=>resolving.promise
  const pending=store.getState().playFromList([current],current.id,{kind:'season',title:'合集'},84,true)
  await new Promise(setImmediate)
  assert.equal(store.getState().current.id,current.id);assert.equal(store.getState().progressSeconds,0)
  resolving.resolve('local://1');await pending
  assert.equal(audio[0].currentTime,expected,`${threshold},${duration}`)
  listeners.pagehide()
 }
})

test('collection resume re-evaluates settings even when its saved track is already loaded',async()=>{
 const {store,audio,listeners}=setup();const current=track('1')
 await store.getState().play(current,40)
 store.getState().setResumeThreshold(null)
 await store.getState().playFromList([current],current.id,{kind:'season',title:'合集'},84,true)
 assert.equal(audio[0].currentTime,0)
 listeners.pagehide()
})


test('loudness is applied before desktop playback, preserves user volume and resets for missing metadata', async () => {
  const h=setup(),{store,audio,listeners}=h
  h.module.setLoudnessPreference(true)
  testApi.plan=async()=>({url:'local://normalized',loudnessGainDb:-6})
  await store.getState().play(track('1'))
  assert.ok(Math.abs(audio[0].volume-.7*Math.pow(10,-6/20))<1e-9)
  assert.equal(store.getState().volume,.7)
  store.getState().setVolume(.4)
  assert.ok(Math.abs(audio[0].volume-.4*Math.pow(10,-6/20))<1e-9)
  assert.equal(store.getState().volume,.4)
  testApi.plan=async()=>({url:'local://no-measurement'})
  await store.getState().play(track('2'))
  assert.equal(audio[0].volume,.4)
  listeners.pagehide()
})

test('late gain plans cannot change a newer track, and latest toggle wins during resolution', async () => {
  const h=setup(),{store,audio,listeners}=h
  h.module.setLoudnessPreference(true)
  const old=deferred(),entered=deferred()
  testApi.plan=async t=>{if(t.id==='1'){entered.resolve();return old.promise}return {url:'local://new',loudnessGainDb:-3}}
  const pending=store.getState().play(track('1'));await entered.promise
  await store.getState().play(track('2'))
  old.resolve({url:'local://old',loudnessGainDb:-18});await pending
  assert.ok(Math.abs(audio[0].volume-.7*Math.pow(10,-3/20))<1e-9)
  const next=deferred(),wait=deferred()
  testApi.plan=async()=>{wait.resolve();return next.promise}
  const loading=store.getState().play(track('3'));await wait.promise
  h.module.setLoudnessPreference(false);await h.module.applyLoudnessSetting()
  next.resolve({url:'local://disabled',loudnessGainDb:-12});await loading
  assert.equal(audio[0].volume,.7)
  assert.equal(store.getState().status,'playing')
  listeners.pagehide()
})

test('prepared quality candidates stay silent and commit only one fresh gain', async () => {
  const h=setup(),{store,audio,listeners}=h
  h.module.setLoudnessPreference(true)
  testApi.plan=async()=>({url:'local://first',loudnessGainDb:-6})
  await store.getState().play(track('1'))
  testApi.plan=async()=>({url:'local://quality',loudnessGainDb:-9})
  const switching=h.module.reloadCurrentAudioSource()
  await switching
  assert.equal(audio.length,2)
  assert.equal(audio[0].paused,true)
  assert.equal(audio[1].muted,false)
  assert.ok(Math.abs(audio[1].volume-.7*Math.pow(10,-9/20))<1e-9)
  assert.equal(store.getState().volume,.7)
  listeners.pagehide()
})
test('desktop shuffle consumes a round once, goes back through real history and restores the pending deck',async()=>{
 const {store:s,listeners,storage}=setup()
 const queue=Array.from({length:10},(_,i)=>track(String(i+1)))
 await s.getState().playFromList(queue,'1');s.getState().toggleShuffle()
 const heard=['1']
 for(let i=1;i<10;i++){await s.getState().next();heard.push(s.getState().current.id)}
 assert.equal(new Set(heard).size,10)
 await s.getState().previous();assert.equal(s.getState().current.id,heard.at(-2))
 await s.getState().next();assert.equal(s.getState().current.id,heard.at(-1))
 listeners.pagehide()
 const persisted=JSON.parse(storage.get('resonance-player-v1'))
 const expected=persisted.state.shuffleState
 const restored=setup(persisted)
 assert.deepEqual(restored.store.getState().shuffleState,expected)
 await restored.store.getState().previous();assert.equal(restored.store.getState().current.id,heard.at(-2))
 restored.listeners.pagehide()
})

test('hidden queue projection preserves its base and explicit enqueue while the audible song finishes',async()=>{
 const {store,module}=setup();const visibility=module.useContentVisibility
 const rule=cid=>({scope:'video:BVTEST00001',target:`cid:${cid}`,hidden:true})
 visibility.setState({rules:[rule(1)]})
 await store.getState().playFromList([track('1'),track('2'),track('3')],'1',{kind:'season',title:'season',collectionRef:'season:1:2'})
 assert.equal(store.getState().current.id,'2');assert.deepEqual(store.getState().queue.map(t=>t.id),['2','3']);assert.equal(store.getState().queueBase.length,3)
 visibility.setState({rules:[rule(1),rule(2)]})
 assert.equal(store.getState().current.id,'2');assert.equal(store.getState().status,'playing')
 await store.getState().next();assert.equal(store.getState().current.id,'3')
 store.getState().enqueue([track('2')]);assert.ok(store.getState().queue.some(t=>t.id==='2'))
 visibility.setState({rules:[rule(1),rule(2),{scope:'season:1:2',target:'BVTEST00001',hidden:true}]})
 assert.deepEqual(store.getState().queue.map(t=>t.id),['2'])
 visibility.setState({rules:[]});assert.equal(store.getState().queue.length,3)
 store.getState().removeFromQueue('1');visibility.setState({rules:[rule(2)]});visibility.setState({rules:[]});assert.equal(store.getState().queue.some(t=>t.id==='1'),false)
})
test('a rule received during source resolution skips the hidden candidate before audio starts',async()=>{
 const {store,module,audio}=setup();const pending=deferred()
 testApi.resolve=async t=>{if(t.id==='1')await pending.promise;return `local://${t.id}`}
 const playing=store.getState().playFromList([track('1'),track('2')],'1',{kind:'video',title:'video',collectionRef:'BVTEST00001'})
 await new Promise(setImmediate)
 module.useContentVisibility.setState({rules:[{scope:'video:BVTEST00001',target:'cid:1',hidden:true}]})
 pending.resolve();await playing
 assert.equal(store.getState().current.id,'2');assert.equal(audio[0].src,'local://2');assert.equal(audio[0].plays,1)
})
test('single repeat stops when every automatic candidate is hidden',async()=>{
 const {store,module}=setup()
 await store.getState().playFromList([track('1')],'1',{kind:'video',title:'video',collectionRef:'BVTEST00001'})
 store.setState({repeatMode:'one'})
 module.useContentVisibility.setState({rules:[{scope:'video:BVTEST00001',target:'cid:1',hidden:true}]})
 await store.getState().next(true);assert.equal(store.getState().status,'paused');assert.equal(store.getState().queue.length,0)
})
test('a newly hidden resume checkpoint picks the next source row at zero, then wraps',async()=>{
 const {store,module,audio}=setup()
 const source={kind:'video',title:'video',collectionRef:'BVTEST00001'}
 module.useContentVisibility.setState({rules:[{scope:'video:BVTEST00001',target:'cid:2',hidden:true}]})
 await store.getState().playFromList([track('1'),track('2'),track('3')],'2',source,85,true)
 assert.equal(store.getState().current.id,'3');assert.equal(audio[0].currentTime,0)
 module.useContentVisibility.setState({rules:[{scope:'video:BVTEST00001',target:'cid:3',hidden:true}]})
 await store.getState().playFromList([track('1'),track('2'),track('3')],'3',source,85,true)
 assert.equal(store.getState().current.id,'1');assert.equal(audio[0].currentTime,0)
})
test('hiding an audible middle row preserves the next position, and hiding the last row ends playback',async()=>{
 const {store,module}=setup(),rows=['1','2','3','4'].map(track)
 await store.getState().playFromList(rows,'3',{kind:'video',title:'video'})
 module.useContentVisibility.setState({rules:[{scope:'video:BVTEST00001',target:'cid:3',hidden:true}]})
 await store.getState().next(true);assert.equal(store.getState().current.id,'4')
 module.useContentVisibility.setState({rules:[3,4].map(cid=>({scope:'video:BVTEST00001',target:`cid:${cid}`,hidden:true}))})
 await store.getState().next(true);assert.equal(store.getState().status,'paused');assert.equal(store.getState().current.id,'4')
})

test('unmanaged search playback and late season adoption ignore old hiding rules and survive restart',async()=>{
 const {store,module,listeners,storage}=setup(),rows=['1','2','3'].map(track)
 module.useContentVisibility.setState({rules:[{scope:'video:BVTEST00001',target:'cid:1',hidden:true}]})
 await store.getState().playFromList(rows,'1',{kind:'video',title:'search',collectionRef:'BVTEST00001',visibilityManaged:false})
 assert.equal(store.getState().current.id,'1');assert.equal(store.getState().queue.length,3)
 module.adoptSeasonQueue(module.playbackIntent(),'1',rows,'season','season:1:2',false)
 assert.equal(store.getState().queue.length,3)
 assert.deepEqual(store.getState().queueOrigins['1'],[''])
 module.useContentVisibility.setState({rules:[{scope:'season:1:2',target:'BVTEST00001',hidden:true}]})
 assert.equal(store.getState().queue.length,3)
 listeners.pagehide()
 const persisted=JSON.parse(storage.get('resonance-player-v1'))
 delete persisted.state.queueOrigins
 const restored=setup(persisted)
 restored.module.useContentVisibility.setState({rules:[{scope:'season:1:2',target:'BVTEST00001',hidden:true}]})
 assert.equal(restored.store.getState().queue.length,3)
 assert.deepEqual(restored.store.getState().queueOrigins['1'],[''])
 restored.listeners.pagehide()
})


test('offline playback keeps the original order and skips songs without complete local audio', async () => {
  const { store, module } = setup()
  const tracks = ['1','2','3','4'].map(track)
  const played = []
  globalThis.testApi.plan = async (song, _refresh, _preferOnline, offlineOnly) => {
    played.push([song.id, offlineOnly])
    return { url: `local://${song.id}` }
  }
  module.useOfflinePlayback.setState({offline: true, library: module.indexOfflineTracks([tracks[1], tracks[3]])})
  await store.getState().playAll(tracks)
  assert.deepEqual(store.getState().queueBase.map(song => song.id), ['1','2','3','4'])
  assert.deepEqual(store.getState().queue.map(song => song.id), ['2','4'])
  await store.getState().play(tracks[2])
  assert.equal(store.getState().current.id, '2')
  await store.getState().next(true)
  assert.equal(store.getState().current.id, '4')
  await store.getState().next(true)
  assert.equal(store.getState().status, 'paused')
  assert.deepEqual(played, [['2', true], ['4', true]])
  module.useOfflinePlayback.setState({offline: false, library: null})
  assert.deepEqual(store.getState().queue.map(song => song.id), ['1','2','3','4'])
})

test('offline video rows resolve only saved parts and keep per-part visibility rules', async () => {
  const { store, module, listeners, storage } = setup()
  const group = {...track('1'), resolveParts: true}
  const first = track('1')
  const second = {...track('2'), source:{...track('2').source,page:2}}
  const groupSource = { kind: 'season', title: '原合集', collectionRef: 'season:1:1', visibilityManaged: true }
  module.useContentVisibility.setState({rules:[{scope:'video:BVTEST00001',target:'cid:1',hidden:true}]})
  module.useOfflinePlayback.setState({offline: true, library: module.indexOfflineTracks([second, first])})
  await store.getState().playFromList([group], group.id, groupSource)
  assert.deepEqual(store.getState().queue.map(item=>item.id),['2'])
  assert.equal(store.getState().current.id,'2')
  listeners.pagehide()
  const restored = setup(JSON.parse(storage.get('resonance-player-v1')))
  assert.deepEqual(restored.store.getState().queueBase.map(item=>item.id),['1'])
})

test('offline resume can explicitly start a non-first saved part inside a grouped queue', async () => {
  const { store, module } = setup()
  const group = {...track('0'), resolveParts: true}
  const first = track('1')
  const second = {...track('2'), source:{...track('2').source,page:2}}
  module.useOfflinePlayback.setState({offline: true, library: module.indexOfflineTracks([first, second])})
  await store.getState().playFromList([group], second.id, undefined, 42, true)
  assert.equal(store.getState().current.id, second.id)
  assert.equal(store.getState().progressSeconds, 42)
  assert.deepEqual(store.getState().queueBase.map(item => item.id), [group.id])
})

test('queue skips confirmed expired videos but still distinguishes a network failure', async () => {
  const { store, listeners } = setup()
  const knownExpired = { ...track('1'), sourceExpired: true }
  const expiredAtResolution = { ...track('2'), source: { ...track('2').source, bvid: 'BVTEST00002' } }
  const playable = { ...track('3'), source: { ...track('3').source, bvid: 'BVTEST00003' } }
  const tried = []
  globalThis.testApi.resolve = async track => {
    tried.push(track.id)
    if (track.id === '2') throw { code: 'source_expired', message: 'B 站视频已失效' }
    return `local://${track.id}`
  }
  await store.getState().playFromList([knownExpired, expiredAtResolution, playable], knownExpired.id)
  assert.equal(store.getState().status, 'playing')
  assert.equal(store.getState().current.id, '3')
  assert.deepEqual(tried, ['2', '3'])

  globalThis.testApi.resolve = async track => {
    tried.push(track.id)
    throw { code: 'provider_error', message: 'Bilibili 接口返回错误 -412: 限流' }
  }
  await store.getState().play(expiredAtResolution)
  assert.equal(store.getState().status, 'error')
  assert.deepEqual(tried, ['2', '3', '2'])
  listeners.pagehide()
})

test('launch playback is opt-in, uses the last position and starts only once', async () => {
  const recent = track('1')
  const state = { current: recent, queue: [recent, track('2')], progressSeconds: 22 }
  const off = setup({ state, version: 2 })
  await off.module.startPlaybackOnLaunch()
  assert.equal(off.audio.length, 0)
  off.listeners.pagehide()

  const on = setup({ state, version: 2 })
  on.storage.set(on.module.launchPlaybackPreference, 'true')
  await on.module.startPlaybackOnLaunch()
  await on.module.startPlaybackOnLaunch()
  assert.equal(on.store.getState().status, 'playing')
  assert.equal(on.store.getState().current.id, '1')
  assert.equal(on.store.getState().progressSeconds, 22)
  assert.equal(on.audio[0].plays, 1)
  on.listeners.pagehide()
})
