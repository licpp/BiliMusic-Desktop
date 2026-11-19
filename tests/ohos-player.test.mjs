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
      export const connection = { hasDefaultNetSync: () => globalThis.ohosTest.networkOnline() };
      export const image = globalThis.ohosTest.image;
      export const rcp = globalThis.ohosTest.rcp;
      export const media = globalThis.ohosTest.media;
      export const audio = globalThis.ohosTest.audio;
      export const avSession = globalThis.ohosTest.avSession;
      export const backgroundTaskManager = globalThis.ohosTest.background;
      export const asset = globalThis.ohosTest.asset;
      export const preferences = {getPreferencesSync:()=>({getSync:()=>false,putSync(){},flush:async()=>{}})};
      export const fileIo = { readTextSync: () => globalThis.ohosTest.scope };
      export const util = globalThis.ohosTest.util;
      export const window = { AvoidAreaType: { TYPE_SYSTEM: 0, TYPE_CUTOUT: 1, TYPE_NAVIGATION_INDICATOR: 4 } };
    ` }))
  } }],
})

function setup() {
  const events = [], samples = [], replies = [], background = [], secrets = new Map(), metadata = [], pixels = [], artworkRequests = [], uploads = []
  const mediaControls = new Map(), sessionActivation = []
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
    networkOnline: () => true,
    native: { bilimusicOhosCancelResolve() {}, bilimusicOhosResolve(request,payload) { h.resolveRequests.push({request,payload:JSON.parse(payload)}) }, tauriOhosPluginResponse: (id, ok, payload) => replies.push({ id, ok, value: JSON.parse(payload) }), bilimusicOhosState: s => events.push(JSON.parse(s)), bilimusicOhosListening: s => samples.push(JSON.parse(s)) },
    media: { createAVPlayer: async () => (player = new FakePlayer()) },
    audio: {
      InterruptForceType: { INTERRUPT_FORCE: 0, INTERRUPT_SHARE: 1 },
      InterruptType: { INTERRUPT_TYPE_BEGIN: 1, INTERRUPT_TYPE_END: 2 },
      InterruptHint: { INTERRUPT_HINT_NONE: 0, INTERRUPT_HINT_RESUME: 1, INTERRUPT_HINT_PAUSE: 2, INTERRUPT_HINT_STOP: 3, INTERRUPT_HINT_DUCK: 4, INTERRUPT_HINT_UNDUCK: 5 },
      StreamUsage: { STREAM_USAGE_MUSIC: 1 },
      DeviceType: { SPEAKER: 2, BLUETOOTH_SCO: 7, BLUETOOTH_A2DP: 8 },
      getAudioManager: () => ({ getRoutingManager: () => ({ getPreferredOutputDeviceForRendererInfoSync: () => h.preferredDevices }) }),
    },
    preferredDevices: [{ deviceType: 2 }],
    avSession: { isDesktopLyricSupported: async () => true, PlaybackState: { PLAYBACK_STATE_PLAY: 1, PLAYBACK_STATE_PAUSE: 2, PLAYBACK_STATE_STOP: 6 }, createAVSession: async () => ({ on(event, callback) { mediaControls.set(event, callback) }, async activate() { sessionActivation.push(true) }, async deactivate() { sessionActivation.push(false) }, async setAVMetadata(value) { if(Object.hasOwn(value,"mediaImage") && value.mediaImage === undefined)throw {code:401,message:"mediaImage property value type invalid"};metadata.push(value) }, async setAVPlaybackState() {}, async enableDesktopLyric(value) { h.desktopLyrics=value }, async setDesktopLyricVisible(value) { h.desktopLyricVisible=value }, async setDesktopLyricState(value) { h.desktopLyricState=value }, async destroy() {} }) },
    background: { BackgroundMode: { AUDIO_PLAYBACK: 2 }, async startBackgroundRunning() { background.push('start') }, async stopBackgroundRunning() { background.push('stop') } },
    asset: { Tag: tags, Accessibility: { DEVICE_FIRST_UNLOCKED: 1 }, ReturnType: { ALL: 1 }, ErrorCode: { NOT_FOUND: 24000002 },
      async update(q, attrs) { if (!secrets.has(key(q))) throw missing(); secrets.set(key(q), attrs.get(tags.SECRET)) },
      async add(q) { secrets.set(key(q), q.get(tags.SECRET)) }, async query(q) { if (!secrets.has(key(q))) throw missing(); return [new Map([[tags.SECRET, secrets.get(key(q))]])] }, async remove(q) { if (!secrets.delete(key(q))) throw missing() },
    },
  }
  h.resolveRequests=[]
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
  let uuid=0; h.util = { generateRandomUUID: () => `session-${++uuid}`, TextEncoder: Encoder, TextDecoder: { create: () => ({ decodeWithStream: b => new TextDecoder().decode(b) }) }, Base64Helper: class { decodeSync(value) { return new Uint8Array(Buffer.from(value, 'base64')) } } }
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
  return { plugin, command, events, samples, replies, background, secrets, metadata, pixels, artworkRequests, uploads, mediaControls, sessionActivation, mock: h, get player() { return player } }
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

test('Bluetooth media metadata keeps the song title, artist and album through live lyrics and route changes', async () => {
  const h = setup()
  const devices = h.mock.audio.DeviceType
  h.mock.preferredDevices = [{ deviceType: devices.BLUETOOTH_A2DP }]
  try {
    await h.command('play', { id: 'song', title: '歌曲', artist: '歌手', album: '专辑', url: 'http://127.0.0.1:1234/media' })
    await h.command('lyrics', { data: JSON.stringify({ action: 'update', id: 'song', lrc: '[00:00]当前歌词',
      lines: [{ timeMs: 0, text: '当前歌词' }] }) })
    await h.command('lyrics', { data: JSON.stringify({ action: 'system-title', enabled: true }) })
    const bluetoothMetadata = h.metadata.at(-1)
    assert.equal(bluetoothMetadata.title, '歌曲')
    assert.equal(bluetoothMetadata.artist, '歌手')
    assert.equal(bluetoothMetadata.album, '专辑')
    assert.equal(bluetoothMetadata.singleLyricText, '当前歌词')
    const routeChanged = h.player.callbacks.audioOutputDeviceChangeWithInfo[0]
    routeChanged({ devices: [{ deviceType: devices.SPEAKER }] })
    await h.plugin.metadataTasks
    assert.equal(h.metadata.at(-1).title, '当前歌词')
    routeChanged({ devices: [{ deviceType: devices.BLUETOOTH_A2DP }] })
    await h.plugin.metadataTasks
    assert.equal(h.metadata.at(-1).title, '歌曲')
    assert.equal(h.metadata.at(-1).artist, '歌手')
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

test('Harmony focus interruptions resume once, preserve buffering intent, and yield to manual pause or stop', async () => {
  const h=setup()
  const interrupt=(hint,eventType=1,player=h.player,forceType=0)=>{for(const cb of player.callbacks.audioInterrupt??[])cb({hintType:hint,eventType,forceType})}
  const settle=async()=>{await h.plugin.tasks;await new Promise(setImmediate)}
  try {
    await h.command('play',{id:'song',url:'http://127.0.0.1:1234/media',position:42,volume:.5})
    interrupt(4);assert.equal(h.player.volume,.5,'system duck must not also apply app attenuation')
    interrupt(5,2);assert.equal(h.player.volume,.5)
    interrupt(4,1,h.player,1);assert.equal(h.player.volume,.1);assert.equal(h.plugin.status,'playing')
    interrupt(5,2,h.player,1);assert.equal(h.player.volume,.5)
    interrupt(2);interrupt(2);await settle();assert.equal(h.plugin.status,'paused')
    interrupt(1,2);await settle();assert.equal(h.plugin.status,'playing');assert.equal(h.player.currentTime,42000)
    await h.command('control',{action:'pause'});interrupt(1,2);await settle();assert.equal(h.plugin.status,'paused')
    await h.command('control',{action:'resume'});interrupt(2);interrupt(1,2)
    await h.command('control',{action:'pause'});await settle();assert.equal(h.plugin.status,'paused')
    await h.command('control',{action:'resume'});interrupt(3);await settle();interrupt(1,2);await settle();assert.equal(h.plugin.status,'paused')
    await h.command('control',{action:'resume'});interrupt(2);await settle();await h.command('control',{action:'stop'});interrupt(1,2);await settle();assert.equal(h.plugin.player,null)
  } finally {await h.plugin.destroy()}
})

test('progressive playback waits for audible progress, then switches at the current clock without changing metadata',async()=>{
 const h=setup()
 try{
  await h.command('play',{id:'song',url:'http://127.0.0.1:1234/fast',upgradeUrl:'http://127.0.0.1:1234/hires',position:12,volume:.4})
  const original=h.plugin.player
  original.currentTime=12500;h.plugin.maybeUpgrade();await h.plugin.tasks;assert.equal(h.plugin.player,original)
  original.currentTime=13500;h.plugin.maybeUpgrade();await h.plugin.tasks
  assert.notEqual(h.plugin.player,original);assert.equal(h.plugin.player.source,'http://127.0.0.1:1234/hires');assert.equal(h.plugin.player.currentTime,13500);assert.equal(h.plugin.player.volume,.4);assert.equal(h.plugin.id,'song');assert.equal(h.plugin.status,'playing')
 }finally{await h.plugin.destroy()}
})
test('automatic quality preparation keeps the low stream playing on failure and never retries endlessly',async()=>{
 const h=setup()
 try{
  await h.command('play',{id:'song',url:'http://127.0.0.1:1234/fast',upgradeUrl:'http://127.0.0.1:1234/hires'})
  const original=h.plugin.player,create=h.mock.media.createAVPlayer;let attempts=0
  h.mock.media.createAVPlayer=async()=>{attempts++;const next=await create();next.prepare=async()=>next.callbacks.error?.[0]({message:'failed'});return next}
  original.currentTime=1000;h.plugin.maybeUpgrade();await h.plugin.tasks
  assert.equal(h.plugin.player,original);assert.equal(original.state,'playing');assert.equal(h.plugin.status,'playing')
  h.plugin.maybeUpgrade();await h.plugin.tasks;assert.equal(attempts,1)
 }finally{await h.plugin.destroy()}
})
test('manual pause, track changes and quality choices take priority over pending automatic upgrades',async()=>{
 const h=setup()
 try{
  await h.command('play',{id:'song',url:'http://127.0.0.1:1234/fast',upgradeUrl:'http://127.0.0.1:1234/hires'})
  const original=h.plugin.player;original.currentTime=1000
  h.plugin.maybeUpgrade();await h.command('control',{action:'pause'});await h.plugin.tasks;assert.equal(h.plugin.player,original);assert.equal(original.state,'paused')
  await h.command('play',{id:'next',url:'http://127.0.0.1:1234/next',upgradeUrl:'http://127.0.0.1:1234/target'})
  await h.command('play',{id:'next',url:'http://127.0.0.1:1234/manual',seamless:true})
  const manual=h.plugin.player;manual.currentTime=2000;h.plugin.maybeUpgrade();await h.plugin.tasks;assert.equal(h.plugin.player,manual);assert.equal(manual.source,'http://127.0.0.1:1234/manual')
 }finally{await h.plugin.destroy()}
})

test('Harmony decides resume from prepared media duration and preserves pause/resume after settings change',async()=>{
 for(const [threshold,listed,position,expected] of [[120,0,85,85],[600,1800,85,0],[null,1800,85,0],[0,0,85,85]]) {
  const h=setup()
  try {
   const reply=await h.command('play',{id:'song',url:'http://127.0.0.1:1234/media',position,automaticResume:{enabled:threshold!==null,thresholdSeconds:threshold??0,collection:false,durationSeconds:listed}})
   assert.equal(reply.ok,true);assert.equal(h.player.currentTime,expected*1000)
   await h.command('control',{action:'pause'});await h.command('control',{action:'resume'})
   assert.equal(h.player.currentTime,expected*1000)
  }finally{await h.plugin.destroy()}
 }
})

const nativeTracks = ['A','B','C'].map((id,i)=>({id,title:id,durationSeconds:180,source:{provider:'bilibili',bvid:`BV${id}`,cid:i+1,page:1}}))
const mirror = (tracks=nativeTracks,repeatMode='off',version=1,extra={})=>({tracks,repeatMode,version,shuffled:false,accountSession:'opaque-account',owner:'webview',...extra})
const drain = async()=>{for(let i=0;i<12;i++)await new Promise(setImmediate)}
async function answer(h,request,track){await h.command('resolved',{request,data:JSON.stringify({track,url:'http://127.0.0.1:1234/'+track.id,position:0})});await drain()}

test('Harmony AVSession next and previous switch tracks in the native queue and refresh media metadata', async () => {
  const h = setup()
  const [first, second, third] = nativeTracks.map(track => ({ ...track, album: '专辑' }))
  try {
    await h.command('queue', mirror([first, second, third]))
    await h.command('play', { ...second, coverUrl: 'https://i0.hdslb.com/art.jpg', url: 'http://127.0.0.1:1234/B' })
    await h.plugin.artworkReady
    assert.equal(h.metadata.at(-1).previousAssetId, first.id)
    assert.equal(h.metadata.at(-1).nextAssetId, third.id)
    h.player.currentTime = 10_000
    await h.command('control', { action: 'previous' })
    assert.equal(h.player.currentTime, 0)
    assert.equal(h.mock.resolveRequests.length, 0)
    h.player.currentTime = 10_000
    h.mediaControls.get('playPrevious')()
    await drain()
    const previous = h.mock.resolveRequests.at(-1)
    assert.equal(previous.payload.track.id, first.id)
    assert.equal(h.metadata.at(-1).assetId, first.id)
    assert.equal(h.metadata.at(-1).mediaImage, undefined)
    await answer(h, previous.request, first)
    assert.equal(h.events.at(-1).status, 'playing')
    assert.equal(h.metadata.at(-1).album, '专辑')
    h.mediaControls.get('playNext')()
    await drain()
    const next = h.mock.resolveRequests.at(-1)
    assert.equal(next.payload.track.id, second.id)
    await answer(h, next.request, second)
    assert.equal(h.events.at(-1).id, second.id)
    assert.equal(h.events.at(-1).status, 'playing')
  } finally { await h.plugin.destroy() }
})

test('Harmony media keys require a distinct target and can select the only remaining track after filtering', async () => {
  for (const event of ['playPrevious', 'playNext']) {
    const h = setup()
    const [first, second] = nativeTracks
    try {
      await h.command('queue', mirror([first]))
      await h.command('play', { ...first, url: 'http://127.0.0.1:1234/A' })
      h.player.currentTime = 10_000
      h.mediaControls.get(event)()
      await drain()
      assert.equal(h.player.currentTime, 10_000)
      assert.equal(h.player.state, 'playing')
      assert.equal(h.mock.resolveRequests.length, 0)
      await h.command('queue', mirror([], 'off', 2))
      h.mediaControls.get(event)()
      await drain()
      assert.equal(h.player.state, 'playing')
      assert.equal(h.mock.resolveRequests.length, 0)
      await h.command('queue', mirror([second], 'off', 3))
      h.mediaControls.get(event)()
      await drain()
      const remaining = h.mock.resolveRequests.at(-1)
      assert.equal(remaining.payload.track.id, second.id)
      await answer(h, remaining.request, second)
      assert.equal(h.events.at(-1).id, second.id)
    } finally { await h.plugin.destroy() }
  }
})

test('rapid Harmony media-key commands ignore stale resolutions and stop deactivates the finished card', async () => {
  const h = setup()
  const [first, second, third] = nativeTracks
  try {
    await h.command('queue', mirror())
    await h.command('play', { ...second, url: 'http://127.0.0.1:1234/B' })
    h.mediaControls.get('playNext')()
    await drain()
    const old = h.mock.resolveRequests.at(-1)
    assert.equal(old.payload.track.id, third.id)
    h.mediaControls.get('playPrevious')()
    await drain()
    const current = h.mock.resolveRequests.at(-1)
    assert.equal(current.payload.track.id, second.id)
    await answer(h, old.request, third)
    assert.equal(h.metadata.at(-1).assetId, second.id)
    await answer(h, current.request, second)
    assert.equal(h.events.at(-1).status, 'playing')
    await h.command('control', { action: 'stop' })
    await drain()
    assert.deepEqual(h.sessionActivation, [true, false])
    h.mediaControls.get('playPrevious')()
    await drain()
    assert.equal(h.mock.resolveRequests.length, 2)
    await h.command('play', { ...first, url: 'http://127.0.0.1:1234/A' })
    assert.deepEqual(h.sessionActivation, [true, false, true])
    assert.equal(h.metadata.at(-1).assetId, first.id)
  } finally { await h.plugin.destroy() }
})

test('Harmony native queue advances A -> B -> C with no frontend consumer and stops at queue end',async()=>{
 const h=setup()
 try {
  await h.command('queue',mirror())
  await h.command('play',{...nativeTracks[0],url:'http://127.0.0.1:1234/A'})
  for(const track of nativeTracks.slice(1)) {
   h.player.emit('completed');await drain()
   const request=h.mock.resolveRequests.at(-1)
   assert.equal(request.payload.track.id,track.id)
   assert.equal(request.payload.accountSession,'opaque-account')
   await answer(h,request.request,track)
   assert.equal(h.events.at(-1).id,track.id)
   assert.equal(h.events.at(-1).status,'playing')
  }
  assert.equal(h.mock.resolveRequests.length,2)
  h.player.emit('completed');await drain()
  assert.equal(h.mock.resolveRequests.length,2)
  assert.equal(h.events.at(-1).status,'paused')
  assert.ok(h.events.every(event=>event.action!=='ended'))
 } finally {await h.plugin.destroy()}
})
test('Harmony pause/stop and removal reject late resolutions; harmless queue reordering preserves the current transition',async()=>{
 const h=setup()
 try {
  await h.command('queue',mirror())
  await h.command('play',{...nativeTracks[0],url:'http://127.0.0.1:1234/A'})
  h.player.emit('completed');await drain()
  const first=h.mock.resolveRequests.at(-1)
  await h.command('control',{action:'pause'})
  await answer(h,first.request,nativeTracks[1])
  assert.notEqual(h.events.at(-1).status,'playing')
  await h.command('play',{...nativeTracks[0],url:'http://127.0.0.1:1234/A'})
  h.player.emit('completed');await drain()
  const next=h.mock.resolveRequests.at(-1)
  await h.command('queue',mirror([...nativeTracks].reverse(),'off',2))
  await answer(h,next.request,nativeTracks[1])
  assert.equal(h.events.at(-1).status,'playing')
  const advancing=h.plugin.advance(1) // reverse order selects A, pending Rust response
  await drain();const removed=h.mock.resolveRequests.at(-1)
  await h.command('queue',mirror([nativeTracks[1],nativeTracks[2]],'off',3))
  await answer(h,removed.request,nativeTracks[0]);await advancing
  assert.equal(h.events.at(-1).status,'paused')
 } finally {await h.plugin.destroy()}
})

test('Harmony repeat-one creates a new logical session and account replacement cancels an in-flight transition',async()=>{
 const h=setup()
 try {
  await h.command('queue',mirror(nativeTracks,'one'))
  await h.command('play',{...nativeTracks[0],url:'http://127.0.0.1:1234/A'})
  const original=h.events.at(-1)
  h.player.emit('completed');await drain()
  const repeat=h.mock.resolveRequests.at(-1)
  assert.equal(repeat.payload.restart,true)
  await answer(h,repeat.request,nativeTracks[0])
  assert.equal(h.events.at(-1).engineInstanceId,original.engineInstanceId)
  assert.notEqual(h.events.at(-1).sessionId,original.sessionId)
  const advancing=h.plugin.advance(1);await drain()
  const request=h.mock.resolveRequests.at(-1)
  await h.command('queue',mirror(nativeTracks,'all',2,{accountSession:'new-account'}))
  await answer(h,request.request,nativeTracks[1]);await advancing
  assert.equal(h.events.at(-1).status,'paused')
 } finally {await h.plugin.destroy()}
})

test('Harmony sleep expiry and stop fence pending native resolution before late replies',async t=>{
 t.mock.timers.enable({apis:['setInterval','setTimeout']})
 const h=setup(),original=Date.now;let now=100000;Date.now=()=>now
 try{
  await h.command('queue',mirror())
  await h.command('play',{...nativeTracks[0],url:'http://127.0.0.1:1234/A'})
  await h.command('control',{action:'sleepStart',value:1})
  h.player.emit('completed');await drain();const pending=h.mock.resolveRequests.at(-1)
  now+=2000;t.mock.timers.tick(1000);await drain()
  await answer(h,pending.request,nativeTracks[1]);assert.notEqual(h.events.at(-1).status,'playing')
  await h.command('control',{action:'sleepCancel'})
  await h.command('play',{...nativeTracks[0],url:'http://127.0.0.1:1234/A'})
  h.player.emit('completed');await drain();const stopped=h.mock.resolveRequests.at(-1)
  await h.command('control',{action:'stop'});await answer(h,stopped.request,nativeTracks[1])
  assert.equal(h.events.at(-1).id,'');assert.equal(h.events.at(-1).status,'paused')
 }finally{Date.now=original;await h.plugin.destroy()}
})

test('Harmony resolution timeout reports an error and cannot later start the expired track',async t=>{
 t.mock.timers.enable({apis:['setInterval','setTimeout']})
 const h=setup()
 try{
  await h.command('queue',mirror())
  await h.command('play',{...nativeTracks[0],url:'http://127.0.0.1:1234/A'})
  h.player.emit('completed');await drain();const pending=h.mock.resolveRequests.at(-1)
  t.mock.timers.tick(25001);await drain()
  assert.equal(h.events.at(-1).status,'error');assert.match(h.events.at(-1).error,/超时/)
  await answer(h,pending.request,nativeTracks[1]);assert.equal(h.events.at(-1).status,'error')
 }finally{await h.plugin.destroy()}
})

test('Harmony background transition replaces notification lyrics from shared native resolution',async()=>{
 const h=setup()
 try{
  await h.command('queue',mirror())
  await h.command('play',{...nativeTracks[0],url:'http://127.0.0.1:1234/A'})
  h.player.emit('completed');await drain();const pending=h.mock.resolveRequests.at(-1)
  await h.command('resolved',{request:pending.request,data:JSON.stringify({track:nativeTracks[1],url:'http://127.0.0.1:1234/B',lyrics:{rawText:'[00:00]新的歌词',lines:[{timeMs:0,text:'新的歌词'}],biasMs:0}})})
  await drain();assert.equal(h.plugin.notificationLine(),'新的歌词');assert.equal(h.plugin.lyricId,nativeTracks[1].id)
 }finally{await h.plugin.destroy()}
})


test('Harmony optional system-title lyrics preserve card artwork and restore song title when disabled or in subtitle gaps',async()=>{
 const h=setup()
 try{
  await h.command('play',{...nativeTracks[0],title:'原来的歌名',artist:'演唱者',url:'http://127.0.0.1:1234/A'})
  await h.command('lyrics',{data:JSON.stringify({action:'update',id:nativeTracks[0].id,subtitles:true,lines:[{timeMs:0,endTimeMs:2000,text:'♪ 当前歌词 ♫'}]})})
  assert.equal(h.plugin.currentMetadata.title,'原来的歌名')
  await h.command('lyrics',{data:JSON.stringify({action:'system-title',enabled:true})})
  assert.equal(h.plugin.currentMetadata.title,'当前歌词');assert.equal(h.plugin.currentMetadata.artist,'演唱者')
  h.player.currentTime=3000;await h.plugin.setMetadata(h.plugin.mediaRevision)
  assert.equal(h.plugin.currentMetadata.title,'原来的歌名')
  await h.command('lyrics',{data:JSON.stringify({action:'system-title',enabled:false})})
  assert.equal(h.plugin.currentMetadata.title,'原来的歌名')
 }finally{await h.plugin.destroy()}
})


test('Harmony starts at unity without an explicit app volume', async () => {
  const h=setup()
  try {
    assert.equal((await h.command('play',{id:'song',url:'http://127.0.0.1:1234/media'})).ok,true)
    assert.equal(h.player.volume,1)
  } finally { await h.plugin.destroy() }
})

test('Harmony applies shared gains before playback and preserves them through duck, volume, source and background queue changes', async () => {
  const h=setup(),near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`)
  try {
    await h.command('play',{id:'song',url:'http://127.0.0.1:1234/media',volume:.8,loudnessGainDb:-6,loudnessEnabled:true,loudnessRevision:2})
    near(h.player.volume,.8*Math.pow(10,-6/20))
    const old = h.player
    const event=(player,hintType,eventType,forceType=1)=>player.callbacks.audioInterrupt[0]({hintType,eventType,forceType})
    event(old,4,1)
    near(h.player.volume,.8*Math.pow(10,-6/20)*.2)
    await h.command('control',{action:'volume',value:.6})
    near(h.player.volume,.6*Math.pow(10,-6/20)*.2)
    event(old,5,1) // A start event must not prematurely undo the duck.
    near(h.player.volume,.6*Math.pow(10,-6/20)*.2)
    event(old,5,2)
    near(h.player.volume,.6*Math.pow(10,-6/20))
    event(old,4,1)
    await h.command('play',{id:'song',url:'http://127.0.0.1:1234/quality',seamless:true,loudnessGainDb:-9,loudnessEnabled:true,loudnessRevision:2})
    event(old,4,1)
    near(h.player.volume,.6*Math.pow(10,-9/20))
    await h.command('control',{action:'loudness',value:0,settingsRevision:3})
    await new Promise(resolve=>setTimeout(resolve,340))
    near(h.player.volume,.6)
    await h.command('play',{id:'song',url:'http://127.0.0.1:1234/stale',seamless:true,loudnessGainDb:-12,loudnessEnabled:true,loudnessRevision:2})
    near(h.player.volume,.6)
    await h.command('play',{id:'next',url:'http://127.0.0.1:1234/next',volume:.6,loudnessGainDb:0,loudnessEnabled:true,loudnessRevision:4})
    near(h.player.volume,.6)
  } finally {await h.plugin.destroy()}
})

test('Harmony starts with transparent system bars and measures offset cutouts and gesture space', async () => {
  const h = setup(), backgrounds = [], bars = [], layouts = []
  let fullScreen = false
  let bounds = { width: 1280, height: 2832 }
  const empty = { left: 0, top: 0, width: 0, height: 0 }
  const area = (edges, visible = true) => ({
    visible, topRect: empty, rightRect: empty, bottomRect: empty, leftRect: empty, ...edges,
  })
  const areas = new Map([
    [0, area({ topRect: { ...empty, height: 136 } })],
    [1, area({ topRect: { ...empty, top: 38, height: 84 } }, false)],
    [4, area({ bottomRect: { ...empty, top: 2734, height: 98 } })],
  ])
  try {
    await h.command('control',{action:'theme',value:1})
    await h.plugin.setWindow({
      async setWindowLayoutFullScreen(value) { layouts.push(value); fullScreen = value },
      setWindowBackgroundColor(value) { backgrounds.push(value) },
      async setWindowSystemBarProperties(value) { bars.push(value) },
      getWindowProperties() { return { isLayoutFullScreen: fullScreen, windowRect: bounds } },
      getWindowAvoidArea(type) { return areas.get(type) },
      getUIContext() { return { px2vp: pixels => pixels / 3.5 } },
    })
    const initial = await h.command('control',{action:'windowInsets'})
    assert.deepEqual(initial.value, { active:true, top:136/3.5, right:0, bottom:28, left:0 })

    await h.command('control',{action:'theme',value:0})
    bounds = { width: 2832, height: 1280 }
    areas.set(1, area({ leftRect: { ...empty, left: 38, width: 84 } }, false))
    areas.set(4, area({ bottomRect: { ...empty, top: 1182, height: 98 } }))
    const rotate = await h.command('control',{action:'windowInsets'})
    assert.deepEqual(rotate.value, { active:true, top:136/3.5, right:0, bottom:28, left:122/3.5 })

    fullScreen = false // The OS can switch the window into floating mode.
    assert.deepEqual((await h.command('control',{action:'windowInsets'})).value,
      { active:false, top:0, right:0, bottom:0, left:0 })
    await h.command('control',{action:'theme',value:0})
    assert.deepEqual(layouts, [true])
    assert.deepEqual(backgrounds, ['#F4F6FA','#071019','#071019'])
    assert.deepEqual(bars,[
      { statusBarColor:'#00000000',navigationBarColor:'#00000000',statusBarContentColor:'#203044',navigationBarContentColor:'#203044' },
      { statusBarColor:'#00000000',navigationBarColor:'#00000000',statusBarContentColor:'#FFFFFF',navigationBarContentColor:'#FFFFFF' },
      { statusBarColor:'#071019',navigationBarColor:'#071019',statusBarContentColor:'#FFFFFF',navigationBarContentColor:'#FFFFFF' },
    ])
  } finally { await h.plugin.destroy() }
})

test('Harmony starts prepared audio while the system media card is still pending', async () => {
  const h = setup()
  let finish = () => {}
  const create = h.mock.avSession.createAVSession
  h.mock.avSession.createAVSession = async () => {
    const session=await create()
    session.setAVMetadata=()=>new Promise(resolve=>{finish=resolve})
    return session
  }
  try {
    const result=await Promise.race([
      h.command('play',{id:'song',url:'http://127.0.0.1:1234/media'}),
      new Promise(resolve=>setTimeout(resolve,100,null)),
    ])
    assert.equal(result?.ok,true)
    assert.equal(h.player.state,'playing')
    assert.equal((await h.command('lyrics',{data:JSON.stringify({action:'update',id:'song',lines:[]})})).ok,true)
    await h.command('control',{action:'pause'})
    assert.equal(h.player.state,'paused')
  } finally { finish(); await h.plugin.destroy() }
})

test('Harmony coalesces playback-state updates while AVSession is slow', async () => {
  const h = setup(), updates = []
  let finish = () => {}
  const create = h.mock.avSession.createAVSession
  h.mock.avSession.createAVSession = async () => {
    const session=await create()
    session.setAVPlaybackState=value=>{
      updates.push(value)
      return updates.length===1 ? new Promise(resolve=>{finish=resolve}) : Promise.resolve()
    }
    return session
  }
  try {
    await h.command('play',{id:'song',url:'http://127.0.0.1:1234/media'})
    await h.command('control',{action:'seek',value:20})
    await h.command('control',{action:'pause'})
    assert.equal(updates.length,1)
    finish(); await new Promise(setImmediate)
    assert.equal(updates.length,2)
    assert.equal(updates[1].state,h.mock.avSession.PlaybackState.PLAYBACK_STATE_PAUSE)
    assert.equal(updates[1].position.elapsedTime,20_000)
  } finally { finish(); await h.plugin.destroy() }
})
