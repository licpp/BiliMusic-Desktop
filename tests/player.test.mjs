import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const output = await build({
  entryPoints: ['src/features/player/playerStore.ts'], bundle: true, write: false,
  format: 'cjs', platform: 'node', external: ['zustand', 'zustand/middleware'],
  plugins: [{ name: 'desktop-boundary', setup(builder) {
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
      export const getTrackPlaybackPlan = async (t,r) => globalThis.testApi.plan ? globalThis.testApi.plan(t,r) : ({url:await getTrackPlaybackUrl(t,r)});
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
  return { store: module.exports.usePlayerStore, audio, listeners, storage }
}
const track = id => ({ id, source: { provider: 'bilibili', bvid: 'BVTEST00001', cid: Number(id), page: 1 }, title: id, durationSeconds: 120, liked: false })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

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
