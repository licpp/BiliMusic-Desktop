import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const result = await build({ entryPoints: ['src/shared/version.ts'], bundle: true, write: false, format: 'esm' })
const { compareVersions } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
test('updates compare preview numbers numerically and do not suggest downgrades', () => {
  for (const [a,b] of [['0.1.6-preview.10','0.1.6-preview.9'],['0.1.6','0.1.6-preview.10'],['0.1.7-preview.1','0.1.6'],['1.0.0-beta','1.0.0-2']]) {
    assert.equal(compareVersions(a,b),1)
    assert.equal(compareVersions(b,a),-1)
  }
  assert.equal(compareVersions('v0.1.6-preview.8+build.20','0.1.6-preview.8'),0)
})
test('invalid server versions fail instead of reporting that the app is current', () => {
  for (const invalid of ['latest','0.1','01.2.3','0.1.6-preview.01','<html>503</html>','0.1.6-']) assert.throws(()=>compareVersions(invalid,'0.1.6'))
})
test('the displayed release identifier belongs to the native bundle version', async () => {
  const {readFile}=await import('node:fs/promises')
  const pkg=JSON.parse(await readFile('package.json','utf8'))
  const native=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8'))
  assert.equal(native.version,pkg.version)
  assert.equal(compareVersions(pkg.version,native.version),0)
  assert.ok(!pkg.version.includes('-'))
})
