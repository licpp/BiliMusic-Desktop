import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const installers = {
  queryKeys: 'installAccountQueryScope',
  localPlayback: 'installLocalPlayback',
  updates: 'startUpdateChecks',
  sync: 'startCloudSync',
  automaticLyrics: 'startAutomaticLyrics',
  listeningStatistics: 'startListeningStatistics',
  preloadNextTrack: 'startPreloadingNextTrack',
  creatorQueue: 'startCreatorQueue',
  floatingLyrics: 'startFloatingLyrics',
}
const output = await build({
  entryPoints: ['src/app/mainWindowRuntime.ts'], bundle: true, write: false, format: 'esm',
  plugins: [{ name: 'runtime-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      const key = args.path.split('/').at(-1)
      if (args.kind === 'import-statement' && installers[key]) return { path: key, namespace: 'runtime-test' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'runtime-test' }, ({ path }) => ({
      contents: `export const ${installers[path]} = (...args) => globalThis.runtimeTest.start(${JSON.stringify(path)}, args)`,
    }))
  } }],
})
const { installMainWindowRuntime } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

test('main window services share one startup order and release their install scope once', () => {
  const started = [], stopped = [], client = {}
  globalThis.runtimeTest = { start(name, args) { started.push({ name, args }); return () => { stopped.push(name) } } }
  const stop = installMainWindowRuntime(client)
  const order = Object.keys(installers)
  assert.deepEqual(started.map(({ name }) => name), order)
  assert.deepEqual(started.filter(({ args }) => args.length).map(({ name, args }) => [name, args[0]]), [['queryKeys', client], ['localPlayback', client], ['sync', client]])
  stop()
  stop()
  assert.deepEqual(stopped, [...order].reverse())
})
