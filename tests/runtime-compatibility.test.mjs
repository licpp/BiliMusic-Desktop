import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createContext, runInContext } from 'node:vm'
import { readFile } from 'node:fs/promises'
import { loadConfigFromFile } from 'vite'

const bundle = async path => (await build({entryPoints:[path],bundle:true,write:false,platform:'browser',format:'cjs',banner:{js:'"use strict";'}})).outputFiles[0].text
const compatibility = await bundle('src/shared/runtimeCompatibility.ts')
const queue = await bundle('src/features/player/queueGroups.ts')
const pageMotion = await bundle('src/shared/pageMotion.ts')
const slides = await bundle('src/shared/slideNavigation.ts')
const uuids = await bundle('src/shared/randomUuid.ts')
const legacy = () => {
  const context = createContext({module:{exports:{}}})
  runInContext('delete Array.prototype.at; delete Object.hasOwn',context)
  return context
}
const tracks = `[{id:'one',resolveParts:true,source:{provider:'bilibili',bvid:'BV1'}},{id:'two',source:{provider:'bilibili',bvid:'BV1'}}]`

test('old WebKit reproduces the playback queue exception, including a restored hidden queue', () => {
  const context = legacy()
  runInContext(queue,context)
  runInContext('globalThis.presentQueue=module.exports.presentQueue',context)
  assert.throws(() => runInContext(`presentQueue(${tracks},'season')`,context),/at is not a function/)
  runInContext(compatibility,context)
  for (let restore=0;restore<2;restore++) {
    assert.equal(runInContext(`presentQueue(${tracks},'season').groups[0].tracks.length`,context),2)
  }
})
test('fallbacks preserve relative indexing and safe own-property detection', () => {
  const context=legacy();runInContext(compatibility,context)
  for(const expression of [
    '[1,2,3].at(-1)===3','[1,2,3].at(-2)===2','[1,2,3].at(1.9)===2','[1,2,3].at(-1.9)===3',
    '[1,2].at(-3)===undefined','[].at(-1)===undefined','[1].at(Infinity)===undefined','[1].at(-Infinity)===undefined',
    '[1].at(NaN)===1', 'Array.prototype.at.call({0:"x",length:1},-1)==="x"',
    'Array.prototype.at.call("abc",-1)==="c"', '!Object.keys([]).includes("at")',
    'Object.hasOwn({x:1},"x")','!Object.hasOwn({},"toString")','Object.hasOwn(Object.assign(Object.create(null),{x:1}),"x")',
    'Object.hasOwn({hasOwnProperty:null,x:1},"x")',
  ]) assert.equal(runInContext(expression,context),true,expression)
  for(const expression of ['Array.prototype.at.call(null,0)','Object.hasOwn(null,"x")','[1].at(1n)'])assert.throws(()=>runInContext(expression,context),/TypeError|Cannot|requires|BigInt/)
})
test('modern engines retain their native APIs and both entries initialize compatibility first',async()=>{
  const context=createContext({module:{exports:{}}});runInContext('globalThis.originalAt=Array.prototype.at;globalThis.originalOwn=Object.hasOwn',context)
  runInContext(compatibility,context);assert.equal(runInContext('originalAt===Array.prototype.at && originalOwn===Object.hasOwn',context),true)
  for(const path of ['src/main.tsx','src/large-screen/main.tsx'])assert.match(await readFile(path,'utf8'),/^import ['"].*runtimeCompatibility['"]/)
})

test('the car entry installs APIs missing from WebView 66 before route and library code runs', async () => {
  const entry = await readFile('src/large-screen/main.tsx', 'utf8')
  const imports = entry.match(/^import ['"]core-js\/[^'"]+['"]$/gm) || []
  const { outputFiles } = await build({
    stdin: { contents: imports.join('\n'), resolveDir: process.cwd() },
    bundle: true,
    write: false,
    target: 'chrome66',
  })
  const context = createContext({ setTimeout })
  runInContext(`
    delete this.globalThis
    delete this.queueMicrotask
    delete Array.prototype.flat
    delete Array.prototype.flatMap
    delete Object.fromEntries
    delete Promise.allSettled
    delete Promise.prototype.finally
    delete String.prototype.matchAll
  `, context)
  runInContext(outputFiles[0].text, context)
  assert.equal(runInContext('globalThis === this && typeof queueMicrotask === "function"', context), true)
  assert.equal(runInContext('[1,2].flatMap(n => [n,n]).join() === "1,1,2,2" && [[3]].flat()[0] === 3', context), true)
  assert.equal(runInContext('Object.fromEntries([["a",1]]).a === 1 && [..."aa".matchAll(/a/g)].length === 2', context), true)
  assert.equal(await runInContext('Promise.allSettled([Promise.resolve(1)]).then(([result]) => result.value).finally(() => {})', context), 1)
})

test('older car WebViews switch routes without the Animation.finished promise', () => {
  const listeners = new Set()
  const preference = {
    matches: false,
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
  }
  const context = createContext({ module: { exports: {} }, window: { matchMedia: () => preference } })
  runInContext(pageMotion, context)
  const { animatePage, stopPageMotion } = context.module.exports
  const element = { animate: () => ({
    finish() { this.onfinish() },
    cancel() { this.oncancel() },
  }) }
  const first = animatePage(element, 'forward', false)
  assert.equal(listeners.size, 1)
  const second = animatePage(element, 'back', false)
  assert.notEqual(first, second)
  assert.equal(listeners.size, 1)
  stopPageMotion(element)
  assert.equal(listeners.size, 0)
  const third = animatePage(element, 'forward', false)
  third.finish()
  assert.equal(listeners.size, 0)
})

const { outputFiles: [mediaQueryHooks] } = await build({
  stdin: {
    contents: `
      export { useCompactLayout } from './src/shared/useCompactLayout'
      export { usePanelPresence } from './src/shared/usePanelPresence'
    `,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: 'cjs', target: 'chrome66',
  plugins: [{
    name: 'compatibility-hook-fixtures',
    setup(builder) {
      builder.onResolve({ filter: /^(react|\.\.\/services\/platform)$/ }, args => ({ path: args.path, namespace: 'fixtures' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixtures' }, args => ({ contents: args.path === 'react'
        ? 'export const useLayoutEffect = effect => captureEffect(effect); export const useEffect = useLayoutEffect; export const useState = initial => [typeof initial === "function" ? initial() : initial, captureState];'
        : 'export const isLargeScreen = largeEdition;' }))
    },
  }],
})

test('shared responsive and presence hooks mount and clean up with both media query listener APIs', () => {
  for (const modern of [false, true]) {
    for (const largeEdition of [false, true]) {
      const effects = [], states = [], active = new Set(), timers = new Set(), queries = []
      const add = listener => active.add(listener)
      const remove = listener => assert.ok(active.delete(listener))
      const query = {
        matches: false,
        ...(modern ? {
          addEventListener(event, listener) { assert.equal(event, 'change'); add(listener) },
          removeEventListener(event, listener) { assert.equal(event, 'change'); remove(listener) },
        } : { addListener: add, removeListener: remove }),
      }
      const context = createContext({
        module: { exports: {} }, largeEdition,
        captureEffect: effect => effects.push(effect), captureState: value => states.push(value),
        window: {
          matchMedia(media) { queries.push(media); return query },
          setTimeout(fn) { timers.add(fn); return fn },
          clearTimeout(fn) { timers.delete(fn) },
        },
      })
      runInContext(mediaQueryHooks.text, context)
      const { useCompactLayout, usePanelPresence } = context.module.exports
      assert.equal(useCompactLayout(), false)
      assert.equal(usePanelPresence(false, 150), false)
      for (let mount = 0; mount < 2; mount++) {
        query.matches = false
        const cleanup = effects.map(effect => effect())
        assert.equal(active.size, largeEdition ? 1 : 2)
        query.matches = true
        for (const listener of active) listener()
        assert.equal(states.at(-1), false)
        if (!largeEdition) assert.equal(states.at(-2), true)
        for (const stop of cleanup) stop?.()
        assert.equal(active.size, 0)
        assert.equal(timers.size, 0)
      }
      assert.equal(queries.includes('(max-width: 960px)'), !largeEdition)
    }
  }
})

test('a slide without a completion promise commits and releases both frames', () => {
  const calls = []
  const context = createContext({
    module: { exports: {} },
    window: { matchMedia: () => ({ matches: false }) },
  })
  runInContext(slides, context)
  const element = name => ({ animate: () => ({ cancel: () => calls.push(name) }) })
  assert.equal(context.module.exports.slideNavigation(element('panel'), 0, 100, 200, () => calls.push('commit'),
    { element: element('indicator'), from: 0, to: 100 }), undefined)
  assert.deepEqual(calls, ['commit', 'indicator', 'panel'])
})

test('secure IDs preserve native UUIDs and use UUID v4 bits with legacy Web Crypto', () => {
  const native = {
    randomUUID() { assert.equal(this, native); return 'native-id' },
    getRandomValues() { assert.fail('The native UUID path should be preferred') },
  }
  const context = createContext({ module: { exports: {} }, crypto: native })
  runInContext(uuids, context)
  const { randomUuid, requireRandomUuid } = context.module.exports
  assert.equal(requireRandomUuid(), 'native-id')
  context.crypto = { getRandomValues: bytes => bytes.fill(255) }
  assert.equal(requireRandomUuid(), 'ffffffff-ffff-4fff-bfff-ffffffffffff')
  delete context.crypto
  assert.equal(randomUuid(), undefined)
  assert.throws(requireRandomUuid, /无法生成安全标识/)
})

test('desktop statistics use secure fallback session IDs and skip initialization if Web Crypto is unavailable', async () => {
  const { outputFiles: [source] } = await build({
    entryPoints: ['src/services/listeningStatistics.ts'], bundle: true, write: false, format: 'cjs',
    plugins: [{
      name: 'statistics-fixtures',
      setup(builder) {
        const fixtures = new Map([
          ['@tauri-apps/api/core', 'export const invoke = nativeCommand'],
          ['./platform', 'export const isMobile = false'],
          ['./desktopApi', 'export const inDesktopShell = true'],
          ['../features/player/playerStore', 'export const usePlayerStore = player; export const playbackClock = clock'],
        ])
        builder.onResolve({ filter: /^(?:@tauri-apps\/api\/core|\.\/platform|\.\/desktopApi|\.\.\/features\/player\/playerStore)$/ }, args =>
          ({ path: args.path, namespace: 'statistics-fixtures' }))
        builder.onLoad({ filter: /.*/, namespace: 'statistics-fixtures' }, args => ({ contents: fixtures.get(args.path) }))
      },
    }],
  })
  let now = 0, position = 0, seed = 0, listener
  const handlers = new Map(), records = []
  const track = id => ({ status: 'playing', current: { id }, rate: 1 })
  const context = createContext({
    module: { exports: {} },
    crypto: { getRandomValues: bytes => bytes.fill(++seed) },
    performance: { now: () => now },
    window: { setInterval() {}, addEventListener: (event, callback) => handlers.set(event, callback) },
    clock: () => position,
    nativeCommand: async (command, body) => {
      if (command === 'listening_scope') return 'test-account'
      assert.equal(command, 'listening_record')
      records.push(body)
    },
    player: { getState: () => track('A'), subscribe: callback => { listener = callback } },
  })
  runInContext(source.text, context)
  const { startListeningStatistics } = context.module.exports
  startListeningStatistics()
  await new Promise(setImmediate)
  now = 2_000; position = 2
  listener(track('B'))
  now = 4_000; position = 4
  handlers.get('pagehide')()
  assert.deepEqual(records.map(record => [record.trackId, record.seconds]), [['A', 2], ['B', 2]])
  assert.notEqual(records[0].sessionId, records[1].sessionId)
  assert.match(records[0].sessionId, /^01010101-0101-4/)
  delete context.crypto
  handlers.clear()
  startListeningStatistics()
  assert.equal(handlers.size, 0)
})

test('only a standard Android build gates its module before old WebViews can load it', async () => {
  const before = process.env.TAURI_ENV_PLATFORM
  const config = async (platform, mode) => {
    process.env.TAURI_ENV_PLATFORM = platform
    return (await loadConfigFromFile({ command: 'build', mode }, undefined, undefined, 'silent', undefined, 'runner')).config
  }
  const plugin = config => config.plugins.find(plugin => plugin.name === 'bilimusic-android-webview-preflight')
  try {
    assert.equal(plugin(await config('windows', 'production')), undefined)
    const car = await config('android', 'large-screen')
    assert.equal(car.build.target, 'chrome66')
    assert.equal(plugin(car), undefined)
    const android = await config('android', 'production')
    assert.equal(android.build.target, 'chrome105')
    const gate = plugin(android).transformIndexHtml
    const html = gate.handler('<script type="module" crossorigin src="/assets/app.js"></script><link rel="modulepreload" crossorigin href="/assets/dependency.js">')
    const entry = html.match(/<meta name="bilimusic-android-entry" content="([^"]+)">/)
    assert.ok(entry)
    assert.doesNotMatch(html, /<script|modulepreload/)

    const boot = await readFile('public/boot.js', 'utf8')
    for (const [gated, supported] of [[true, false], [true, true], [false, false]]) {
      const scripts = [], notices = [], warning = { hidden: true }
      let ready
      const document = {
        addEventListener(event, listener) { assert.equal(event, 'DOMContentLoaded'); ready = listener },
        querySelector: () => gated ? { content: entry[1] } : null,
        createElement: () => ({}),
        head: { appendChild: script => scripts.push(script) },
        getElementById(id) {
          return id === 'app-bootstrap'
            ? { removeAttribute() {}, setAttribute: name => notices.push(name) }
            : warning
        },
      }
      const CSS = { supports: feature => feature === 'selector(:has(*))' && supported }
      runInContext(boot, createContext({ document, window: { CSS }, CSS }))
      assert.equal(scripts.length, 0)
      ready()
      assert.deepEqual(scripts, gated && supported ? [{ type: 'module', crossOrigin: 'anonymous', src: '/assets/app.js' }] : [])
      assert.deepEqual(notices, gated && !supported ? ['data-webview-upgrade'] : [])
      assert.equal(warning.hidden, !gated || supported)
    }
  } finally {
    if (before === undefined) delete process.env.TAURI_ENV_PLATFORM
    else process.env.TAURI_ENV_PLATFORM = before
  }
})
