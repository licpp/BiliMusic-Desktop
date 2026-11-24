import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const compiled=await build({entryPoints:['src/services/playlistImportPolicy.ts'],bundle:true,write:false,format:'esm'})
const {ImportRequestPolicy,isImportRateLimit,isUnavailableImportCandidate}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
test('limit detection recognizes API, HTTP and displayed search restrictions without matching embedded IDs',()=>{
 for(const error of ['HTTP 412','HTTP status client error (429 Too Many Requests)','Bilibili 接口返回错误 -412: 请求被拦截',{message:'B站提示限制搜索'},{message:'B 站暂时限制了搜索'},{code:'bili_rate_limited',message:''},'-352','-509','-799'])assert.equal(isImportRateLimit(error),true,JSON.stringify(error))
 for(const error of ['HTTP 404','HTTP 503','track 123412789','track 100352789','value 352','Bilibili 接口返回错误 -101: 未登录'])assert.equal(isImportRateLimit(error),false,error)
})
test('pacing uses a three-second search gap and spaces detail reads',()=>{
 let now=100_000;const p=new ImportRequestPolicy(()=>now)
 assert.equal(p.searchWait(),0);p.searched();assert.equal(p.searchWait(),3000);now+=1000;assert.equal(p.searchWait(),2000);now+=2000;assert.equal(p.searchWait(),0)
 p.detailed();assert.equal(p.detailWait(),500);now+=500;assert.equal(p.detailWait(),0)
})
test('unavailable video codes skip candidates while a native hold interrupts the task', () => {
 assert.equal(isUnavailableImportCandidate({code:'source_unavailable'}),true)
 assert.equal(isUnavailableImportCandidate({code:'source_expired'}),true)
 assert.equal(isUnavailableImportCandidate({code:'bili_rate_limited'}),false)
})
test('restrictions extend cooldown, slow subsequent searches and restore across a restart',()=>{
 let now=100_000;const p=new ImportRequestPolicy(()=>now)
 assert.equal(p.restricted(0),220_000);assert.equal(p.searchInterval,6000)
 now+=120_000;assert.equal(p.searchWait(),0)
 assert.equal(p.restricted(1),520_000);assert.equal(p.searchInterval,12000)
 const restored=new ImportRequestPolicy(()=>now);restored.restore(p.blockedUntil,2)
 assert.equal(restored.searchWait(),300_000);assert.equal(restored.searchInterval,12000)
 assert.equal(p.restricted(2),1_120_000);p.restore(1,0);assert.equal(p.searchWait(),900_000)
 p.reset();assert.equal(p.searchWait(),0);assert.equal(p.searchInterval,3000)
})
