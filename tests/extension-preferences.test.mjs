import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const bundle = await build({
  entryPoints: ['src/services/extensions.ts'],
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external',
})
const key = 'extensions.enabled.v1'

function withPreference(raw) {
  const values = new Map([[key, raw]])
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  return () => {
    const module = { exports: {} }
    new Function('require', 'module', 'localStorage', bundle.outputFiles[0].text)(require, module, storage)
    return module.exports.useExtensionPreferences.getState()
  }
}

test('extensions default off and persist independent choices across launches', () => {
  const launch = withPreference()
  assert.deepEqual(launch().enabledIds, [])
  const { setEnabled } = launch()
  setEnabled('feed', true)
  setEnabled('qq', true)
  setEnabled('feed', true)
  assert.deepEqual(launch().enabledIds, ['feed', 'qq'])
  const restarted = launch()
  restarted.setEnabled('feed', false)
  assert.deepEqual(launch().enabledIds, ['qq'])
  restarted.setEnabled('qq', false)
  assert.deepEqual(launch().enabledIds, [])
})

test('invalid local settings recover and edits preserve other extension IDs', () => {
  assert.deepEqual(withPreference('{')().enabledIds, [])
  assert.deepEqual(withPreference('{"qq":true}')().enabledIds, [])
  const launch = withPreference('["qq","future",5,"qq"]')
  launch().setEnabled('qq', false)
  assert.deepEqual(launch().enabledIds, ['future'])
})
