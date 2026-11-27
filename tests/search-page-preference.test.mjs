import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const bundle = await build({
  entryPoints: ['src/services/searchPagePreference.ts'],
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external',
})

test('simple search defaults on and keeps the chosen mode on restart', () => {
  const preferences = new Map()
  const storage = {
    getItem: key => preferences.get(key) ?? null,
    setItem: (key, value) => preferences.set(key, value),
  }
  const load = () => {
    const module = { exports: {} }
    new Function('require', 'module', 'localStorage', bundle.outputFiles[0].text)(require, module, storage)
    return module.exports.useSearchPagePreference
  }
  const initial = load()
  assert.equal(initial.getState().simple, true)
  initial.getState().toggle()
  const restarted = load()
  assert.equal(restarted.getState().simple, false)
  restarted.getState().toggle()
  assert.equal(load().getState().simple, true)
})
