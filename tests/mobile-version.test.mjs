import test from 'node:test'
import assert from 'node:assert/strict'
import {mobileVersion,syncMobileVersion} from '../scripts/mobile-version.mjs'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
test('0.4.0 uses stable platform build numbers and preserves native upgrade order',()=>{
 const previous=mobileVersion('0.3.7',1), basic=mobileVersion('0.4.0',1)
 const patch=mobileVersion('0.4.0',2), next=mobileVersion('0.4.1',1)
 assert.deepEqual([previous,basic,patch,next].map(info=>info.androidVersionCode),[30700,40000,40001,40100])
 assert.deepEqual([previous,basic,patch,next].map(info=>info.iosBundleVersion),['3.7.99','1004.0.50','1004.0.51','1004.1.50'])
 assert.equal(mobileVersion('0.4.0',50).iosBundleVersion,'1004.0.99')
 assert.throws(()=>mobileVersion('0.4.0',51))
 assert.throws(()=>mobileVersion('0.4.0-preview',2))
})
test('preview upgrades stable 0.3.5 and stays below stable 0.3.6 on Android and iOS',()=>{
 const previous=mobileVersion('0.3.5'),preview=mobileVersion('0.3.6-preview'),stable=mobileVersion('0.3.6')
 assert.equal(previous.androidVersionCode,30500)
 assert.equal(preview.androidVersionCode,30599)
 assert.equal(stable.androidVersionCode,30600)
 assert.ok(previous.androidVersionCode<preview.androidVersionCode&&preview.androidVersionCode<stable.androidVersionCode)
 assert.equal(preview.nativeVersion,'0.3.6')
 assert.equal(preview.iosBundleVersion,'3.6.1')
 assert.equal(stable.iosBundleVersion,'3.6.99')
 assert.equal(mobileVersion('0.3.6-preview.2').iosBundleVersion,'3.6.2')
 for(const invalid of ['0.3.6-preview.0','0.3.6-preview.99','0.3.6-unknown'])assert.throws(()=>mobileVersion(invalid))
})
test('stable builds replace preview metadata automatically and preserve native identities',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bilimusic-version-'))
 try {
  await mkdir(join(dir,'src-tauri'))
  await writeFile(join(dir,'package.json'),JSON.stringify({version:'0.3.6-preview'}))
  for(const [platform,id] of [['android','app.bilimusic.mobile'],['large-screen','app.bilimusic.large'],['ios','app.bilimusic.ios']])await writeFile(join(dir,`src-tauri/tauri.${platform}.conf.json`),JSON.stringify({identifier:id}))
  const root=pathToFileURL(dir+'/')
  await syncMobileVersion(root)
  assert.equal(JSON.parse(await readFile(join(dir,'src-tauri/tauri.android.conf.json'))).bundle.android.versionCode,30599)
  assert.equal(JSON.parse(await readFile(join(dir,'src-tauri/tauri.large-screen.conf.json'))).bundle.android.versionCode,30599)
  await writeFile(join(dir,'package.json'),JSON.stringify({version:'0.3.6'}))
  await syncMobileVersion(root)
  const android=JSON.parse(await readFile(join(dir,'src-tauri/tauri.android.conf.json'))),ios=JSON.parse(await readFile(join(dir,'src-tauri/tauri.ios.conf.json')))
  assert.equal(android.identifier,'app.bilimusic.mobile');assert.equal(ios.identifier,'app.bilimusic.ios')
  assert.equal(android.bundle.android.versionCode,30600);assert.equal(ios.bundle.iOS.bundleVersion,'3.6.99')
  const large=JSON.parse(await readFile(join(dir,'src-tauri/tauri.large-screen.conf.json')))
  assert.equal(large.identifier,'app.bilimusic.large');assert.equal(large.bundle.android.versionCode,30600)
 } finally {await rm(dir,{recursive:true,force:true})}
})
