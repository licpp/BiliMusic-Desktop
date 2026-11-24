import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const bundled = await build({
  stdin: { resolveDir: process.cwd(), contents: `
    export * from './src/services/diagnostics'
    export * from './src/services/accountScope'
  ` },
  bundle: true,
  format: 'esm',
  write: false,
  plugins: [{
    name: 'diagnostic-ipc',
    setup(build) {
      build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'fixture' }))
      build.onLoad({ filter: /^ipc$/, namespace: 'fixture' }, () => ({ contents: `
        export const isTauri = () => true
        export const invoke = (...args) => globalThis.diagnosticsFixture(...args)
      ` }))
    },
  }],
})
const { advanceAccountEpoch, diagnosticsRecent, startDiagnosticTrace } =
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

globalThis.window = new EventTarget()
const flushed = () => new Promise(resolve => setImmediate(resolve))

test('a late diagnostic session lookup cannot log a previous account operation under the new account', async () => {
  const sent = []
  let admitSession
  globalThis.diagnosticsFixture = (command, args) => command === 'account_session' ?
    new Promise(resolve => { admitSession = resolve }) : Promise.resolve(sent.push([command, args]))
  const trace = startDiagnosticTrace('playback', { bvid: 'BV1JX73ztEEo', cid: 9 })
  trace.emit('source', 'failed', { code: 'track_missing' })
  advanceAccountEpoch()
  admitSession('next-session')
  await flushed()
  assert.deepEqual(sent, [])
})

test('an attempt groups source, media readiness and recovery, and captures its context before each asynchronous send', async () => {
  const sent = []
  globalThis.diagnosticsFixture = (command, args) => Promise.resolve(command === 'account_session' ? 'current-session' : sent.push(args))
  const trace = startDiagnosticTrace('playback', { bvid: 'BV1JX73ztEEo', cid: 9, engine: 'android-media-player' })
  trace.emit('recovery', 'started', { initialCode: 'android_media:100:1' })
  trace.update({ source: 'cache', actualQuality: 30280, codec: 'mp4a.40.2' })
  trace.emit('source', 'succeeded')
  trace.emit('media-ready', 'succeeded')
  await flushed()
  assert.deepEqual(sent.map(item => item.event.step), ['recovery', 'source', 'media-ready'])
  assert.ok(sent.every(item => item.expectedAccountSession === 'current-session' && item.event.operation === trace.operation))
  assert.equal(sent[0].event.source, undefined)
  assert.equal(sent[0].event.initialCode, 'android_media:100:1')
  assert.equal(sent[2].event.codec, 'mp4a.40.2')
  assert.equal(sent[2].event.actualQuality, 30280)
})

test('a report fetched across an account change is discarded before it reaches the UI', async () => {
  let report
  globalThis.diagnosticsFixture = (command, args) => command === 'account_session' ? Promise.resolve('old-session') :
    new Promise(resolve => {
      assert.equal(args.expectedAccountSession, 'old-session')
      assert.equal(args.area, 'download')
      report = resolve
    })
  const pending = diagnosticsRecent(undefined, 'download')
  await flushed()
  advanceAccountEpoch()
  report([{ at: 1, event: { area: 'download' } }])
  await assert.rejects(pending, /账号已切换/)
})
