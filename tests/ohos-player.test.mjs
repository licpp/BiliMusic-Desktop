import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const output = await build({
  entryPoints: ['native/ohos-player/ohos/PlayerPlugin.ets'], loader: { '.ets': 'ts' }, resolveExtensions: ['.ets', '.ts', '.js'], bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'harmony-system', setup(b) {
    b.onResolve({ filter: /^(@kit\.|libbilimusic_lib)/ }, args => ({ path: args.path, namespace: 'harmony' }))
    b.onLoad({ filter: /.*/, namespace: 'harmony' }, args => ({ contents: args.path === 'libbilimusic_lib.so' ? 'export default globalThis.ohosTest.native' : `
      export const wantAgent = globalThis.ohosTest.wantAgent;
      export const deviceInfo = { sdkApiVersion: 26 };
      export const hilog = { info() {}, error() {}, warn() {} };
      export const http = globalThis.ohosTest.http;
      export const image = globalThis.ohosTest.image;
      export const rcp = globalThis.ohosTest.rcp;
      export const media = globalThis.ohosTest.media;
      export const avSession = globalThis.ohosTest.avSession;
      export const backgroundTaskManager = globalThis.ohosTest.background;
      export const asset = globalThis.ohosTest.asset;
      export const fileIo = { readTextSync: () => globalThis.ohosTest.scope };
      export const util = globalThis.ohosTest.util;
    ` }))
  } }],
})

function setup() {
  const events = [], samples = [], replies = [], background = [], secrets = new Map(), metadata = [], pixels = [], artworkRequests = [], uploads = []
  let player
  class FakePlayer {
    constructor() { this.callbacks = {}; this.currentTime = 0; this.duration = 180_000; this.state = 'idle' }
    // AVPlayer's second registration replaces the previous callback, unlike a
    // Node EventEmitter. This reproduces the real pause/resume regression.
    on(event, callback) { this.callbacks[event] = [callback] }
    emit(state) { this.state = state; for (const cb of this.callbacks.stateChange ?? []) cb(state) }
    set url(value) { this.source = value; this.emit('initialized') }
    async prepare() { this.emit('prepared') }
    async play() { this.emit('playing') }
    async pause() { this.emit('paused') }
    async release() { this.emit('released') }
    seek(ms) { this.currentTime = ms; for(const cb of this.callbacks.seekDone ?? []) cb() }
    setSpeed(value) { this.speed = value }
    setVolume(value) { this.volume = value }
  }
  // Match Harmony TextEncoder.encodeInto's byte-array return type.
  class Encoder { encodeInto(value) { return new TextEncoder().encode(value) } }
  const tags = { ALIAS: 1, SECRET: 2, ACCESSIBILITY: 3, RETURN_TYPE: 4 }
  const key = q => new TextDecoder().decode(q.get(tags.ALIAS))
  const missing = () => Object.assign(new Error('missing'), { code: 24000002 })
  const h = globalThis.ohosTest = {
    scope: '123',
    native: { tauriOhosPluginResponse: (id, ok, payload) => replies.push({ id, ok, value: JSON.parse(payload) }), bilimusicOhosState: s => events.push(JSON.parse(s)), bilimusicOhosListening: s => samples.push(JSON.parse(s)) },
    media: { createAVPlayer: async () => (player = new FakePlayer()) },
    avSession: { isDesktopLyricSupported: async () => true, PlaybackState: { PLAYBACK_STATE_PLAY: 1, PLAYBACK_STATE_PAUSE: 2 }, createAVSession: async () => ({ on() {}, async activate() {}, async setAVMetadata(value) { if(Object.hasOwn(value,"mediaImage") && value.mediaImage === undefined)throw {code:401,message:"mediaImage property value type invalid"};metadata.push(value) }, async setAVPlaybackState() {}, async enableDesktopLyric(value) { h.desktopLyrics=value }, async setDesktopLyricVisible(value) { h.desktopLyricVisible=value }, async setDesktopLyricState(value) { h.desktopLyricState=value }, async destroy() {} }) },
    background: { BackgroundMode: { AUDIO_PLAYBACK: 2 }, async startBackgroundRunning() { background.push('start') }, async stopBackgroundRunning() { background.push('stop') } },
    asset: { Tag: tags, Accessibility: { DEVICE_FIRST_UNLOCKED: 1 }, ReturnType: { ALL: 1 }, ErrorCode: { NOT_FOUND: 24000002 },
      async update(q, attrs) { if (!secrets.has(key(q))) throw missing(); secrets.set(key(q), attrs.get(tags.SECRET)) },
      async add(q) { secrets.set(key(q), q.get(tags.SECRET)) }, async query(q) { if (!secrets.has(key(q))) throw missing(); return [new Map([[tags.SECRET, secrets.get(key(q))]])] }, async remove(q) { if (!secrets.delete(key(q))) throw missing() },
    },
  }
  h.artworkReply = async () => ({ responseCode: 200, result: new ArrayBuffer(4) })

  h.http = { RequestMethod: { GET: 'GET' }, HttpDataType: { ARRAY_BUFFER: 2 }, createHttp() {
    const request = { destroyed: false, destroy() { this.destroyed = true }, request(url, options) { artworkRequests.push({ url, options, request }); return h.artworkReply(url) } }
    return request
  } }
  h.image = { createImageSource() { return { async getImageInfo() { return { size: { width: 1600, height: 900 } } }, async createPixelMap(options) {
    const value = { size: options.desiredSize, released: false, async release() { this.released = true } }; pixels.push(value); return value
  }, async release() {} } } }
  h.uploadReply = async () => ({ statusCode: 201 })
  h.rcp = { Request: class { constructor(url, method, headers, content, cookies, range, configuration) { Object.assign(this, { url, method, headers, content, configuration }) } }, createSession() {
    const session={destroyed:false,async fetch(request) { if(request.method==='GET'){artworkRequests.push({url:request.url,options:request,request:session});const reply=await h.artworkReply(request.url);return {statusCode:reply.responseCode,body:reply.result}} uploads.push(request);return h.uploadReply(request) },close(){this.destroyed=true}};return session
  } }
  const finalCode = output.outputFiles[0].text
  h.util = { generateRandomUUID: () => 'session', TextEncoder: Encoder, TextDecoder: { create: () => ({ decodeWithStream: b => new TextDecoder().decode(b) }) }, Base64Helper: class { decodeSync(value) { return new Uint8Array(Buffer.from(value, 'base64')) } } }
  // wantAgent is a separate named export in AbilityKit.
  h.wantAgent = { OperationType: { START_ABILITY: 1 }, WantAgentFlags: { UPDATE_PRESENT_FLAG: 1 }, async getWantAgent() { return {} } }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', finalCode)(createRequire(import.meta.url), module, module.exports)
  const plugin = new module.exports.PlayerPlugin({ async startAbility() {} })
  let id = 0
  const command = async (name, args = {}) => {
    const current = ++id
    plugin.dispatch(JSON.stringify({ id: current, plugin: 'ohos-player', command: name, payload: JSON.stringify(args) }))
    await plugin.tasks
    for (let i = 0; i < 8 && !replies.some(r => r.id === current); i++) await new Promise(setImmediate)
    return replies.find(r => r.id === current)
  }
  return { plugin, command, events, samples, replies, background, secrets, metadata, pixels, artworkRequests, uploads, mock: h, get player() { return player } }
}

test('Harmony player prepares real native transport, preserves position/rate, and stops its background task on pause', async () => {
  const h = setup()
  try {
    assert.equal((await h.command('play', { id: 'song', url: 'http://127.0.0.1:1234/media', position: 12, rate: 1.5, volume: .4 })).ok, true)
    assert.equal(h.player.currentTime, 12_000)
    assert.equal(h.player.speed, 6)
    assert.equal(h.player.volume, .4)
    assert.equal((await h.command('snapshot')).value.status, 'playing')
    await h.command('control', { action: 'pause' })
    assert.equal((await h.command('snapshot')).value.status, 'paused')
    assert.equal(h.events.at(-1).status, 'paused')
    for (let i = 0; i < 2; i++) {
      await h.command('control', { action: 'resume' })
      assert.equal((await h.command('snapshot')).value.status, 'playing')
      assert.equal(h.events.at(-1).status, 'playing')
      await h.command('control', { action: 'pause' })
      assert.equal((await h.command('snapshot')).value.status, 'paused')
      assert.equal(h.events.at(-1).status, 'paused')
    }
    assert.deepEqual(h.background, ['start', 'stop', 'start', 'stop', 'start', 'stop'])
    assert.equal((await h.command('play', { id: 'song', url: 'https://evil.example/music' })).ok, false)
  } finally { await h.plugin.destroy() }
})

test('Harmony sync credentials use the asset store, including update and idempotent deletion', async () => {
  const h = setup()
  try {
    assert.equal((await h.command('secret', { key: 'sync-123-jianguoyun', value: 'test-secret' })).ok, true)
    assert.equal((await h.command('secret', { key: 'sync-123-jianguoyun' })).value.value, 'test-secret')
    await h.command('secret', { key: 'sync-123-jianguoyun', value: 'changed' })
    assert.equal((await h.command('secret', { key: 'sync-123-jianguoyun' })).value.value, 'changed')
    await h.command('secret', { key: 'sync-123-jianguoyun', remove: true })
    assert.equal((await h.command('secret', { key: 'sync-123-jianguoyun', remove: true })).ok, true)
    assert.equal(h.secrets.size, 0)
    assert.equal((await h.command('secret', { key: 'unrelated', value: 'no' })).ok, false)
  } finally { await h.plugin.destroy() }
})

test('listening samples count elapsed playback, exclude seeks and pauses, and retain the existing account scope', async () => {
  const h = setup(), originalNow = Date.now
  let now = 100_000; Date.now = () => now
  try {
    await h.command('observe_listening', { profilePath: '/sandbox/active-profile' })
    await h.command('play', { id: 'song', url: 'http://127.0.0.1:1234/media' })
    h.plugin.accountListening()
    for (let i = 0; i < 16; i++) { now += 1000; h.player.currentTime += 1000; h.plugin.accountListening() }
    assert.equal(h.samples.filter(s => s.seconds).reduce((sum, s) => sum + s.seconds, 0), 15)
    await h.command('control', { action: 'seek', value: 100 })
    await h.command('control', { action: 'pause' })
    const counted = h.samples.filter(s => s.seconds).reduce((sum, s) => sum + s.seconds, 0)
    assert.equal(counted, 16)
    now += 30_000; h.plugin.accountListening(true)
    assert.equal(h.samples.filter(s => s.seconds).reduce((sum, s) => sum + s.seconds, 0), counted)
    assert.ok(h.samples.every(s => s.scope === '123' && s.trackId === 'song'))
  } finally { await h.plugin.destroy(); Date.now = originalNow }
})

test('media session receives decoded cover pixels with Bilibili headers and preserves the cover aspect ratio', async () => {
  const h = setup()
  try {
    await h.command('play', { id: 'song', title: '歌曲', artist: '歌手', url: 'http://127.0.0.1:1234/media', coverUrl: '//i0.hdslb.com/cover.jpg' })
    await h.plugin.artworkReady
    assert.equal(h.artworkRequests[0].url, 'https://i0.hdslb.com/cover.jpg')
    assert.equal(h.artworkRequests[0].options.headers.Referer, 'https://www.bilibili.com/')
    assert.deepEqual(h.metadata.at(-1), { assetId: 'song', title: '歌曲', artist: '歌手', duration: 180_000, mediaImage: h.pixels[0], lyric: '' })
    assert.deepEqual(h.pixels[0].size, { width: 384, height: 216 })
    assert.equal(h.artworkRequests[0].request.destroyed, true)
  } finally { await h.plugin.destroy() }
  assert.equal(h.pixels[0].released, true)
})

test('a late old cover cannot overwrite the next song and failed covers do not interrupt playback', async () => {
  const h = setup(); let resolveOld
  h.mock.artworkReply = url => url.endsWith('old.jpg') ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve({ responseCode: 200, result: new ArrayBuffer(4) })
  try {
    await h.command('play', { id: 'old', url: 'http://127.0.0.1:1234/old', coverUrl: 'https://i0.hdslb.com/old.jpg' })
    const old = h.plugin.artworkReady
    await h.command('play', { id: 'new', url: 'http://127.0.0.1:1234/new', coverUrl: 'https://i0.hdslb.com/new.jpg' })
    await h.plugin.artworkReady
    const current = h.metadata.at(-1)
    resolveOld({ responseCode: 200, result: new ArrayBuffer(4) }); await old
    assert.equal(h.metadata.at(-1), current)
    assert.equal(current.assetId, 'new')
    assert.equal(h.pixels.length, 1)
    h.mock.artworkReply = async () => { throw new Error('offline') }
    assert.equal((await h.command('play', { id: 'offline', url: 'http://127.0.0.1:1234/offline', coverUrl: 'https://i0.hdslb.com/offline.jpg' })).ok, true)
    await h.plugin.artworkReady
    assert.equal((await h.command('snapshot')).value.status, 'playing')
    assert.equal(h.metadata.at(-1).assetId, 'offline')
    assert.equal(h.metadata.at(-1).mediaImage, undefined);assert.equal(Object.hasOwn(h.metadata.at(-1),'mediaImage'),false,'a missing cover must not invalidate the complete media card')
  } finally { await h.plugin.destroy() }
})

const upload = body => ({ url: 'https://dav.jianguoyun.com/dav/BiliMusic-sync-v1/42/12345678-1234-4234-8234-123456789abc.json', authorization: 'Basic dGVzdDp0ZXN0', bodyBase64: body.toString('base64') })
test('native WebDAV uploads exact snapshot bytes, disables redirects, and returns HTTP denials unchanged', async () => {
  const h = setup()
  try {
    const body = Buffer.from(JSON.stringify({ text: '歌曲信息'.repeat(100_000) }))
    assert.equal((await h.command('webdav_put', upload(body))).value.status, 201)
    const request = h.uploads[0]
    assert.equal(request.method, 'PUT')
    assert.deepEqual(Buffer.from(request.content), body)
    assert.equal(request.headers['Content-Length'], String(body.length))
    assert.equal(request.configuration.transfer.autoRedirect, false)
    assert.equal(request.configuration.security, undefined) // System certificate validation stays enabled.
    h.mock.uploadReply = async () => ({ statusCode: 401 })
    assert.equal((await h.command('webdav_put', upload(body))).value.status, 401)
    assert.equal((await h.command('webdav_put', { ...upload(body), url: 'https://evil.example/dav/BiliMusic-sync-v1/42/12345678-1234-4234-8234-123456789abc.json' })).ok, false)
    assert.equal(h.uploads.length, 2)
  } finally { await h.plugin.destroy() }
})

test('a pending WebDAV upload does not block native pause or snapshot commands', async () => {
  const h = setup(); let finish
  h.mock.uploadReply = () => new Promise(resolve => { finish = resolve })
  try {
    await h.command('play', { id: 'song', url: 'http://127.0.0.1:1234/media' })
    h.plugin.dispatch(JSON.stringify({ id: 999, plugin: 'ohos-player', command: 'webdav_put', payload: JSON.stringify(upload(Buffer.from('{}'))) }))
    await h.command('control', { action: 'pause' })
    assert.equal((await h.command('snapshot')).value.status, 'paused')
    assert.ok(!h.replies.some(r => r.id === 999))
    finish({ statusCode: 201 }); await new Promise(setImmediate)
    assert.equal(h.replies.find(r => r.id === 999).value.status, 201)
  } finally { await h.plugin.destroy() }
})

test('Harmony notification lyrics follow the native clock automatically, preserve artwork, and fall back in subtitle gaps', async () => {
  const h=setup()
  try {
    await h.command('play',{id:'song',title:'歌曲',artist:'歌手',url:'http://127.0.0.1:1234/media',coverUrl:'https://i0.hdslb.com/art.jpg'})
    await h.plugin.artworkReady
    await h.command('lyrics',{data:JSON.stringify({action:'update',id:'song',lrc:'[00:01.000]你好',lines:[{timeMs:1000,endTimeMs:2000,text:'你好'},{timeMs:3000,endTimeMs:4000,text:'下一句'}],subtitles:true})})
    assert.equal(h.metadata.at(-1).artist,'歌手')
    h.player.currentTime=1500;await h.plugin.setMetadata(h.plugin.mediaRevision)
    assert.equal(h.metadata.at(-1).artist,'你好');assert.equal(h.metadata.at(-1).title,'歌曲');assert.equal(h.metadata.at(-1).mediaImage,h.pixels[0])
    const count=h.metadata.length;await h.plugin.setMetadata(h.plugin.mediaRevision);assert.equal(h.metadata.length,count,'unchanged lyrics do not flood system metadata')
    h.player.currentTime=2500;await h.plugin.setMetadata(h.plugin.mediaRevision);assert.equal(h.metadata.at(-1).artist,'歌手')
    h.player.currentTime=3500;await h.plugin.setMetadata(h.plugin.mediaRevision);assert.equal(h.metadata.at(-1).artist,'下一句')
    const legacy=await h.command('lyrics',{data:JSON.stringify({action:'enable',enabled:true})});assert.equal(legacy.value.enabled,false)
    await h.command('play',{id:'next',artist:'新歌手',url:'http://127.0.0.1:1234/media2'})
    assert.equal(h.metadata.at(-1).lyric,'');assert.equal(h.metadata.at(-1).artist,'新歌手')
  } finally { await h.plugin.destroy() }
})

test('a queued lyric refresh cannot erase artwork decoded while an older metadata task was pending',async()=>{
 const h=setup();let reply,release
 h.mock.artworkReply=()=>new Promise(resolve=>{reply=resolve})
 try {
  await h.command('play',{id:'song',title:'歌曲',artist:'歌手',url:'http://127.0.0.1:1234/media',coverUrl:'https://i0.hdslb.com/art.jpg'})
  h.plugin.metadataTasks=new Promise(resolve=>{release=resolve})
  reply({responseCode:200,result:new ArrayBuffer(4)})
  for(let i=0;i<4;i++)await new Promise(setImmediate)
  const lyrics=h.command('lyrics',{data:JSON.stringify({action:'update',id:'song',lines:[{timeMs:0,text:'当前歌词'}]})})
  release();await lyrics;await h.plugin.artworkReady
  assert.equal(h.metadata.at(-1).mediaImage,h.pixels[0]);assert.equal(h.metadata.at(-1).artist,'当前歌词')
  assert.equal(h.pixels[0].released,false)
 } finally {release?.();await h.plugin.destroy()}
})

test('a native pause during slow preparation is immediate and prevents deferred autoplay', async () => {
  const h=setup(), create=h.mock.media.createAVPlayer
  let release,waiting=false
  const barrier=new Promise(resolve=>{release=resolve})
  h.mock.media.createAVPlayer=async()=>{
    const player=await create()
    player.prepare=async()=>{waiting=true;await barrier;player.emit('prepared')}
    return player
  }
  try {
    h.plugin.dispatch(JSON.stringify({id:900,plugin:'ohos-player',command:'play',payload:JSON.stringify({id:'slow',url:'http://127.0.0.1:1234/slow'})}))
    for(let i=0;i<8&&!waiting;i++)await new Promise(setImmediate)
    assert.ok(waiting)
    h.plugin.dispatch(JSON.stringify({id:901,plugin:'ohos-player',command:'control',payload:JSON.stringify({action:'pause'})}))
    await new Promise(setImmediate)
    assert.ok(h.replies.some(reply=>reply.id===901&&reply.ok),'pause does not queue behind the preparation promise')
    assert.equal(h.events.at(-1).status,'paused')
    release();await h.plugin.tasks
    assert.equal(h.player.state,'prepared')
    assert.equal(h.events.at(-1).status,'paused')
    assert.deepEqual(h.background,[])
  }finally{release();await h.plugin.destroy()}
})

test('stop cancels a preparation promise so the following native request can proceed', async () => {
  const h=setup(),create=h.mock.media.createAVPlayer
  let waiting=false
  h.mock.media.createAVPlayer=async()=>{
    const player=await create()
    player.prepare=async()=>{waiting=true}
    return player
  }
  try{
    h.plugin.dispatch(JSON.stringify({id:910,plugin:'ohos-player',command:'play',payload:JSON.stringify({id:'slow',url:'http://127.0.0.1:1234/slow'})}))
    for(let i=0;i<8&&!waiting;i++)await new Promise(setImmediate)
    assert.ok(waiting)
    h.plugin.dispatch(JSON.stringify({id:911,plugin:'ohos-player',command:'control',payload:JSON.stringify({action:'stop'})}))
    await h.plugin.tasks;await new Promise(setImmediate)
    assert.ok(h.replies.some(reply=>reply.id===911&&reply.ok))
    assert.equal((await h.command('snapshot')).value.stopped,true)
    h.mock.media.createAVPlayer=create
    assert.equal((await h.command('play',{id:'next',url:'http://127.0.0.1:1234/next'})).ok,true)
    assert.equal(h.player.state,'playing')
  }finally{await h.plugin.destroy()}
})

test('quality preparation keeps the original transport playing and a pause during preparation wins at handoff',async()=>{
 const h=setup()
 let release
 try{
  await h.command('play',{id:'song',url:'http://127.0.0.1:1234/original'})
  const original=h.player;original.currentTime=42000
  const create=h.mock.media.createAVPlayer,barrier=new Promise(resolve=>{release=resolve})
  h.mock.media.createAVPlayer=async()=>{const next=await create();next.prepare=async()=>{await barrier;next.emit('prepared')};return next}
  h.plugin.dispatch(JSON.stringify({id:970,plugin:'ohos-player',command:'play',payload:JSON.stringify({id:'song',url:'http://127.0.0.1:1234/new',seamless:true})}))
  for(let i=0;i<8;i++)await new Promise(setImmediate)
  assert.equal(original.state,'playing')
  assert.equal(h.events.at(-1).status,'playing')
  original.currentTime=45000
  h.plugin.dispatch(JSON.stringify({id:971,plugin:'ohos-player',command:'control',payload:JSON.stringify({action:'pause'})}))
  await new Promise(setImmediate);assert.equal(original.state,'paused')
  release();await h.plugin.tasks
  assert.equal(h.player.currentTime,45000)
  assert.equal(h.events.at(-1).status,'paused')
  assert.ok(h.replies.some(reply=>reply.id===970&&reply.ok))
 }finally{release?.();await h.plugin.destroy()}
})
test('a failed quality candidate leaves the original transport and clock intact',async()=>{
 const h=setup()
 try{
  await h.command('play',{id:'song',url:'http://127.0.0.1:1234/original'})
  const original=h.player,create=h.mock.media.createAVPlayer;original.currentTime=22000
  h.mock.media.createAVPlayer=async()=>{const next=await create();next.prepare=async()=>{next.callbacks.error?.[0]({message:'failed'})};return next}
  assert.equal((await h.command('play',{id:'song',url:'http://127.0.0.1:1234/bad',seamless:true})).ok,false)
  assert.equal(original.state,'playing')
  assert.equal((await h.command('snapshot')).value.position,22)
  assert.equal(h.events.at(-1).status,'playing')
 }finally{await h.plugin.destroy()}
})

test('quality handoff restores the original player when the prepared candidate cannot start',async()=>{
 const h=setup()
 try{
  await h.command('play',{id:'song',url:'http://127.0.0.1:1234/original'})
  const original=h.player;original.currentTime=21_000
  const create=h.mock.media.createAVPlayer
  h.mock.media.createAVPlayer=async()=>{const player=await create();player.play=async()=>{throw new Error('decoder failed')};return player}
  assert.equal((await h.command('play',{id:'song',url:'http://127.0.0.1:1234/candidate',seamless:true})).ok,false)
  assert.equal(h.plugin.player,original)
  assert.equal(original.state,'playing')
  assert.equal(original.currentTime,21_000)
  assert.equal((await h.command('snapshot')).value.status,'playing')
 }finally{await h.plugin.destroy()}
})
