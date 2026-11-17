import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {readFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {importEntryCommand} from './fixtures/import-entry-store.mjs'
globalThis.throughputCommand=importEntryCommand

// Both variants execute the production importer. The control changes only the
// worker count; API timings and request pacing stay identical.
const variants=new Map()
for(const concurrency of [1,2]){
 const compiled=await build({entryPoints:['src/services/playlistImport.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'virtual-import-network',setup(b){
  b.onLoad({filter:/[/\\]src[/\\]services[/\\]playlistImport\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace('const MATCH_CONCURRENCY = 2',`const MATCH_CONCURRENCY = ${concurrency}`),loader:'ts',resolveDir:dirname(args.path)}))
  b.onResolve({filter:/desktopApi$|accountScope$|^@tauri-apps\/api\/core$/},a=>({path:a.path,namespace:'fixture'}))
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path.endsWith('desktopApi')?`
   export const inDesktopShell=true;export const commandErrorMessage=e=>String(e);export const listPlaylistTracks=async()=>[];
   export const searchBilibili=keyword=>globalThis.throughputFixture.search(keyword);
   export const getVideoParts=bvid=>globalThis.throughputFixture.detail(bvid);
  `:path.endsWith('accountScope')?'export const accountEpoch=()=>0':`export const invoke=async(command,args)=>{if(command==='playlist_import_scope')return 'benchmark';const entryResult=globalThis.throughputCommand(globalThis.throughputFixture,command,args);if(entryResult!==undefined)return entryResult;if(command==='playlist_import_archive')return null;if(command==='playlist_import_commit'){globalThis.throughputFixture.commits.push(args);return {id:args.playlistId,name:args.name}};throw new Error(command)}`}))
 }}]})
 variants.set(concurrency,compiled.outputFiles[0].text)
}
const flush=()=>new Promise(setImmediate)
async function scenario(t,concurrency,latency){
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000})
 globalThis.window=new EventTarget()
 const f=globalThis.throughputFixture={scope:'benchmark',searches:[],details:0,commits:[]}
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
 const hit=i=>({bvid:`BV1GJ411x7h${i}`,title:`Artist - Song ${i}`,durationSeconds:269,playCount:100000,uploaderName:'UP',description:''})
 f.search=async keyword=>{const i=Number(keyword.match(/Song (\d)/)[1]);f.searches.push(Date.now());await sleep(latency);return {items:[hit(i)]}}
 f.detail=async bvid=>{f.details++;await sleep(600);const i=Number(bvid.at(-1));return {...hit(i),aid:1,coverUrl:'',uploaderId:1,parts:[{cid:100+i,page:1,title:`Song ${i}`,durationSeconds:269,coverUrl:''}]}}
 const api=await import(`data:text/javascript;base64,${Buffer.from(variants.get(concurrency)+`\n// latency fixture: ${latency}`).toString('base64')}`)
 try{
  await api.bootPlaylistImport()
  api.newPlaylistImport({source:'text',name:'benchmark',songs:Array.from({length:4},(_,i)=>({sourceId:String(i),title:`Song ${i}`,artists:['Artist'],durationSeconds:269}))},'benchmark')
  const start=Date.now();let done=false
  const run=api.runPlaylistImport().finally(()=>done=true)
  for(let i=0;i<1000&&!done;i++){await flush();if(!done)t.mock.timers.tick(100)}
  assert.equal(done,true,'the simulated importer must complete');await run
  assert.equal(api.usePlaylistImport.getState().job.state,'done')
  assert.equal(f.searches.length,4);assert.equal(f.details,4)
  assert.deepEqual(f.commits.flatMap(write=>write.entries.map(entry=>entry.track.cid)),[100,101,102,103])
  assert.ok(f.searches.slice(1).every((time,i)=>time-f.searches[i]>=3000),'parallel matching must not compress the search request interval')
  return {elapsed:Date.now()-start,requests:f.searches.length+f.details}
 }finally{api.pausePlaylistImport();await flush();t.mock.timers.reset()}
}
test('two-worker pipeline reduces slow-network waiting without increasing requests or losing order',async t=>{
 const serial=await scenario(t,1,5000),parallel=await scenario(t,2,5000)
 t.diagnostic(`simulated slow network: serial=${serial.elapsed}ms, two workers=${parallel.elapsed}ms, requests=${parallel.requests}`)
 assert.equal(serial.requests,parallel.requests);assert.ok(parallel.elapsed<serial.elapsed*0.8)
})
test('fast-network throughput remains bounded by pacing rather than extra worker count',async t=>{
 const serial=await scenario(t,1,100),parallel=await scenario(t,2,100)
 t.diagnostic(`simulated fast network: serial=${serial.elapsed}ms, two workers=${parallel.elapsed}ms, requests=${parallel.requests}`)
 assert.equal(serial.requests,parallel.requests);assert.ok(Math.abs(serial.elapsed-parallel.elapsed)<=100)
})
