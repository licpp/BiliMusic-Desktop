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
        : args.seconds === undefined ? globalThis.testApi.positions.get(args.trackId) || 0 : undefined;
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
    src = ''; currentTime = 0; volume = 1; duration = 120; callbacks = {}; plays = 0; readyState = 3; seeking = false; paused = true
    constructor() { audio.push(this) }
    addEventListener(name, callback) { this.callbacks[name] = callback }
    removeEventListener(name, callback) { if(this.callbacks[name]===callback)delete this.callbacks[name] }
    pause() { this.paused = true; this.callbacks.pause?.() }
    load() {}
    removeAttribute() { this.src = '' }
    async play() { this.paused = false; this.plays++; this.callbacks.playing?.() }
  }
  globalThis.testApi = { positions:new Map(), record: async track => track, resolve: async track => `local://${track.id}` }
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

test('disabled single-video resume retains multipart and collection checkpoints', async () => {
  const base=track('1')
  for (const [current,queueSource] of [[{...base,partCount:2},undefined],[{...base,source:{...base.source,page:2}},undefined],[base,{kind:'season',title:'合集'}],[base,{kind:'video',title:'选集',collectionRef:'BVTEST00001'}]]) {
    const {store,audio,listeners}=setup({state:{current,queue:[current],queueSource,progressSeconds:32,durationSeconds:120,resumeThresholdSeconds:null},version:0})
    await store.getState().toggle()
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
