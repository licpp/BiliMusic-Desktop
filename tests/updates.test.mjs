import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
const compiled = await build({entryPoints:['src/services/updates.ts'],bundle:true,write:false,format:'cjs',platform:'node',plugins:[{name:'update-boundaries',setup(b){
 b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'ipc',namespace:'mock'}))
 b.onResolve({filter:/player\/playerStore$/},()=>({path:'player',namespace:'mock'}))
 b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='player'?'export const prepareForApplicationUpdate=async()=>{globalThis.updateTest.flushed++}':`export const isTauri=()=>true;export const invoke=(...args)=>globalThis.updateTest.invoke(...args);export class Channel{set onmessage(fn){globalThis.updateTest.progress=fn}}`}))
}}]})
function setup(invoke) {
 const f=globalThis.updateTest={invoke,flushed:0}
 globalThis.window=Object.assign(new EventTarget(),{setTimeout:fn=>(f.first=fn,1),setInterval:fn=>(f.tick=fn,2)})
 globalThis.document=Object.assign(new EventTarget(),{hidden:false})
 const m={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
 return {...m.exports, f}
}
const newer={version:'9.0.0',available:true,installable:true,requestId:'plan-one',platform:'android-large',size:100}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {resolve,reject,promise}}
test('one check/download at a time, verified completion and permission retry retain the prepared plan',async()=>{
 const checking=deferred(),downloading=deferred();let calls=[],installCount=0
 const a=setup(async(cmd,args)=>{calls.push([cmd,args]);if(cmd==='app_check_update')return checking.promise;if(cmd==='app_download_update')return downloading.promise;if(cmd==='app_install_update')return ++installCount===1?'permission-required':'installer-opened';throw Error(cmd)})
 const work=a.checkUpdates();await a.checkUpdates();assert.equal(calls.length,1)
 checking.resolve(newer);await work;assert.equal(a.useUpdateStore.getState().result.status,'available')
 const download=a.downloadUpdate();await a.downloadUpdate();await a.checkUpdates();assert.equal(calls.length,2)
 a.f.progress({phase:'downloading',received:50,total:100});assert.equal(a.useUpdateStore.getState().received,50)
 a.f.progress({phase:'ready',received:100,total:100});assert.equal(a.useUpdateStore.getState().phase,'downloading','IPC event alone cannot enable installation')
 downloading.resolve();await download;assert.equal(a.useUpdateStore.getState().phase,'ready')
 a.f.progress({phase:'downloading',received:10,total:100});assert.equal(a.useUpdateStore.getState().phase,'ready','late progress cannot regress a ready plan')
 await a.installUpdate();assert.match(a.useUpdateStore.getState().notice,/请允许安装/);assert.equal(a.useUpdateStore.getState().phase,'ready')
 await a.installUpdate();assert.match(a.useUpdateStore.getState().notice,/系统安装器/);assert.equal(a.f.flushed,2)
 assert.deepEqual(calls.filter(c=>c[0]==='app_install_update').map(c=>c[1]),[{requestId:'plan-one'},{requestId:'plan-one'}])
})
test('failed downloads are retryable and stale progress cannot overwrite a newer operation',async()=>{
 let first=true,past;const pending=deferred()
 const a=setup(async(cmd)=>{if(cmd==='app_check_update')return newer;if(cmd==='app_download_update'){if(first){first=false;past=a.f.progress;throw Error('安装包校验失败')}return pending.promise}})
 await a.checkUpdates();await a.downloadUpdate();assert.match(a.useUpdateStore.getState().error,/校验失败/)
 const retry=a.downloadUpdate();past({phase:'verifying',received:100,total:100});assert.equal(a.useUpdateStore.getState().phase,'downloading')
 pending.resolve();await retry;assert.equal(a.useUpdateStore.getState().phase,'ready')
})
test('startup check is automatic, shared across mounts and does not download or install',async()=>{
 let calls=[];const a=setup(async cmd=>{calls.push(cmd);return {...newer,version:'0.1.0'}})
 const stop=a.startUpdateChecks();assert.equal(a.startUpdateChecks(),stop)
 a.f.first();await new Promise(setImmediate);a.f.tick();document.dispatchEvent(new Event('visibilitychange'));await new Promise(setImmediate)
 assert.deepEqual(calls,['app_check_update']);assert.equal(a.useUpdateStore.getState().result.status,'ahead');stop()
})
test('legacy releases without an OTA artifact retain the website fallback',async()=>{
 const calls=[];const a=setup(async cmd=>{calls.push(cmd);return {version:'9.0.0',available:true}})
 await a.checkUpdates();await a.downloadUpdate();await a.installUpdate();assert.deepEqual(calls,['app_check_update'])
})

test('a larger build of the installed version is offered only when the selected platform changed', async () => {
 const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
 const result = { version, available: true, currentBuild: 1 }
 for (const [build, status] of [[2, 'available'], [1, 'current'], [0, 'ahead']]) {
  const app = setup(async () => ({ ...result, build }))
  assert.equal((await app.checkForUpdate()).status, status)
 }
 const next = setup(async () => ({ ...result, version: '9.0.0', build: 1, currentBuild: 50 }))
 assert.equal((await next.checkForUpdate()).status, 'available')
})

test('signed builds and the Rust verifier use the same public key',async()=>{
 const {readFile}=await import('node:fs/promises')
 const key=(await readFile('src-tauri/update-public-key.txt','utf8')).trim()
 const config=JSON.parse(await readFile('src-tauri/tauri.updater.conf.json','utf8'))
 assert.equal(config.bundle.createUpdaterArtifacts,true)
 const base=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8'))
 assert.equal(base.plugins.updater.pubkey,key)
 assert.equal(config.plugins,undefined,'signing overlay inherits the ordinary startup configuration')
 assert.match(await readFile('src-tauri/src/lib.rs','utf8'),/include_str!\("\.\.\/update-public-key\.txt"\)/)
})

test('a matching iOS build is current even when the catalog says a package is available', async () => {
 const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
 const app = setup(async () => ({ version, platform: 'ios', currentBuild: 3, build: 3, available: true }))
 assert.equal((await app.checkForUpdate()).status, 'current')
})
