import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
test('late lyric download cannot write into a newly selected account library', async () => {
  globalThis.isTauri = true
  globalThis.window = { crypto: webcrypto, dispatchEvent() {} }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Macintosh' } })
  const stored = { trackId: 'bilibili:BV1:1', provider: 'lrclib', providerLyricId: '1', rawText: '', parsedJson: '[]', biasMs: 100, selectedManually: true }
  let resolveCandidate, restores = 0, writes = 0
  mockIPC((command) => {
    if (command === 'lyrics_get') return stored
    if (command === 'lyrics_restore_selected') { restores++; return new Promise(resolve => { resolveCandidate = resolve }) }
    if (command === 'lyrics_save') { writes++; return stored }
  })
  try {
    const compiled = await build({ stdin: { contents: "export { getStoredLyrics } from './src/services/desktopApi'; export { advanceAccountEpoch } from './src/services/accountScope'", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'cjs', platform: 'node', write: false })
    const module = { exports: {} }
    new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
    const pending = module.exports.getStoredLyrics(stored.trackId)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(restores, 1)
    module.exports.advanceAccountEpoch()
    resolveCandidate({ provider: 'lrclib', id: 1, syncedLyrics: '[00:01.00]old account lyric' })
    assert.equal(await pending, null)
    assert.equal(writes, 0)
  } finally { clearMocks() }
})

test('late sync metadata refresh cannot overwrite the next account player', async () => {
  globalThis.window = { crypto: webcrypto, dispatchEvent() {} }
  let finish, updates = 0
  mockIPC(command => {
    assert.equal(command, 'sync_current_track')
    return new Promise(resolve => { finish = resolve })
  })
  globalThis.accountRefreshTest = { current: { id: 'same-track' }, updateTrack() { updates++ } }
  try {
    const compiled = await build({
      stdin: { contents: "export { refreshSyncedLibrary } from './src/services/sync'; export { advanceAccountEpoch } from './src/services/accountScope'", resolveDir: process.cwd(), loader: 'ts' },
      bundle:true, format:'cjs', platform:'node', write:false,
      plugins:[{name:'player-boundary',setup(builder){
        builder.onResolve({filter:/playerStore$/},()=>({path:'player',namespace:'mock'}))
        builder.onResolve({filter:/desktopApi$/},()=>({path:'api',namespace:'mock'}))
        builder.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='player' ? 'export const usePlayerStore={getState:()=>globalThis.accountRefreshTest}' : 'export const inDesktopShell=false; export const fromStoredTrack=t=>t;'}))
      }}],
    })
    const module={exports:{}}
    new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
    const pending=module.exports.refreshSyncedLibrary({invalidateQueries:async()=>{}})
    await new Promise(setImmediate)
    assert.equal(typeof finish,'function')
    module.exports.advanceAccountEpoch()
    finish({id:'same-track',title:'previous account metadata'})
    await pending
    assert.equal(updates,0)
  } finally {clearMocks()}
})
