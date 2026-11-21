import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)

async function fixture(t, corrupt, harmony = false, large = false) {
  const root = await mkdtemp(join(tmpdir(), 'bilimusic-download-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sha256 = createHash('sha256').update('package').digest('hex')
  const platforms = ['mac', 'windows', 'android', 'ios', ...(harmony ? ['ohos'] : []), ...(large ? ['android-large'] : [])].map(id => ({ id, file: `${id}.bin`, size: 7, sha256, channels: ['github', 'gitee'].map(source => ({ id: source, url: `https://example.test/${source}/${id}` })) }))
  const plan = join(root, 'plan.json'), report = join(root, 'report.json'), preload = join(root, 'fetch.mjs')
  await writeFile(plan, JSON.stringify({ manifest: { platforms } }))
  await writeFile(preload, `globalThis.fetch=async url=>{const response=new Response(${JSON.stringify(corrupt ? 'changed' : 'package')});Object.defineProperty(response,'url',{value:url});return response}`)
  return { plan, report, preload }
}

test('download workflow reports all eight hashes before activation', async t => {
  const { plan, report, preload } = await fixture(t, false)
  await run(process.execPath, ['--import', preload, resolve('scripts/verify_release_downloads.mjs'), plan, report, 'a'.repeat(64)])
  const data = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(data.results.length, 8)
  assert.equal(new Set(data.results.map(r => r.url)).size, 8)
  assert.ok(data.results.every(r => r.size === 7))
})

test('four-platform releases also verify both retained Harmony downloads', async t => {
  const { plan, report, preload } = await fixture(t, false, true)
  await run(process.execPath, ['--import', preload, resolve('scripts/verify_release_downloads.mjs'), plan, report, 'a'.repeat(64)])
  const data = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(data.results.length, 10)
  assert.equal(data.results.filter(r => r.platform === 'ohos').length, 2)
})

test('six packages verify twelve downloads including the separate large-screen edition', async t => {
  const { plan, report, preload } = await fixture(t, false, true, true)
  await run(process.execPath, ['--import', preload, resolve('scripts/verify_release_downloads.mjs'), plan, report, 'a'.repeat(64)])
  const data = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(data.results.length, 12)
  assert.equal(data.results.filter(r => r.platform === 'android-large').length, 2)
})

test('the two car update IDs verify each universal APK URL only once', async t => {
  const { plan, report, preload } = await fixture(t, false, false, true)
  const data = JSON.parse(await readFile(plan, 'utf8'))
  const car = data.manifest.platforms.find(platform => platform.id === 'android-large')
  car.architecture = 'ARM64 / ARMv7'
  const legacy = { ...car, id: 'android-large-armv7' }
  data.manifest.platforms.unshift(legacy)
  await writeFile(plan, JSON.stringify(data))
  const verify = () => run(process.execPath, ['--import', preload, resolve('scripts/verify_release_downloads.mjs'), plan, report, 'a'.repeat(64)])
  await verify()
  const { results } = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(results.length, 10)
  assert.equal(results.filter(item => item.platform === 'android-large').length, 2)
  legacy.size += 1
  await writeFile(plan, JSON.stringify(data))
  await assert.rejects(verify(), /Unexpected duplicate public download URL/)
})

test('a same-size corrupted download prevents the activation proof', async t => {
  const { plan, report, preload } = await fixture(t, true)
  await assert.rejects(run(process.execPath, ['--import', preload, resolve('scripts/verify_release_downloads.mjs'), plan, report, 'a'.repeat(64)]), /SHA-256 mismatch/)
  await assert.rejects(access(report))
})

test('metadata backups reuse locally verified originals without network requests', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bilimusic-metadata-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const original = join(root, 'build-info.json'), report = join(root, 'release-report.json'), preload = join(root, 'offline.mjs')
  const sha256 = createHash('sha256').update('package').digest('hex')
  await writeFile(original, 'package')
  await writeFile(preload, 'globalThis.fetch=()=>{throw new Error("Network must not be used") }')
  await writeFile(report, JSON.stringify({ planDigest: 'a'.repeat(64), originalMetadata: [{ channel: 'github', name: 'build-info.json', size: 7, sha256, id: 123, url: 'https://example.test/build-info.json' }] }))
  await run(process.execPath, ['--import', preload, resolve('scripts/backup_release_metadata.mjs'), report, root, root])
  const proof = JSON.parse(await readFile(join(root, 'metadata-backup-proof.json'), 'utf8'))
  assert.equal(proof.results[0].sha256, sha256)
  assert.equal(await readFile(join(root, 'original-assets/github/build-info.json'), 'utf8'), 'package')
})

test('public GitHub ranges cover every byte once and retain the full-file hash', async () => {
  const { verifyPublicAsset } = await import('../download_release_asset.mjs')
  const bytes=Buffer.alloc(700000);for(let i=0;i<bytes.length;i++)bytes[i]=i%251
  const platform={id:'android-large',file:'large.apk',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
  const ranges=[]
  const request=async (url,options)=>{
    const [,start,end]=/bytes=(\d+)-(\d+)/.exec(options.headers.Range).map(Number)
    ranges.push([start,end])
    const response=new Response(bytes.subarray(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${bytes.length}`,etag:'"fixed"','content-type':'application/vnd.android.package-archive'}})
    Object.defineProperty(response,'url',{value:url});return response
  }
  const result=await verifyPublicAsset(platform,{id:'github',url:'https://example.test/public.apk'},request)
  assert.equal(result.sha256,platform.sha256);assert.equal(result.size,bytes.length)
  assert.deepEqual(ranges.sort((a,b)=>a[0]-b[0]),[[0,262143],[262144,524287],[524288,699999]])
})

test('range downloads reject ignored ranges, changed entities and truncated bodies', async () => {
  const { verifyPublicAsset } = await import('../download_release_asset.mjs')
  const platform={id:'mac',file:'app.dmg',size:600000,sha256:'a'.repeat(64)},channel={id:'github',url:'https://example.test/app.dmg'}
  for(const fault of ['range','etag','body']){
    const request=async(url,options)=>{
      const [,start,end]=/bytes=(\d+)-(\d+)/.exec(options.headers.Range).map(Number)
      const response=new Response(Buffer.alloc(end-start+(fault==='body'?0:1)),{status:fault==='range'?200:206,headers:{'content-range':`bytes ${start}-${end}/${platform.size}`,etag:fault==='etag'?String(start):'fixed'}})
      Object.defineProperty(response,'url',{value:url});return response
    }
    await assert.rejects(verifyPublicAsset(platform,channel,request),fault==='range'?/range mismatch/:fault==='etag'?/changed during/:/Incomplete/)
  }
})

const fastPackage={id:'android-large',file:'large.apk',size:700000,sha256:'b'.repeat(64)}
const fastChannel={id:'github',url:'https://example.test/large.apk'}
const fastReceipt={channel:'github',releaseId:1,assetId:2,name:'large.apk',size:700000,sha256:'b'.repeat(64),method:'server-sha256'}
function publicResponse(url,{status=200,headers={}}={}) {const r=new Response(null,{status,headers});Object.defineProperty(r,'url',{value:url});return r}

test('verified upload hashes need only a HEAD and never read package bytes',async()=>{
  const {probePublicAsset}=await import('../download_release_asset.mjs')
  const calls=[]
  const result=await probePublicAsset(fastPackage,fastChannel,fastReceipt,async(url,options)=>{
    calls.push(options.method);assert.equal(options.method,'HEAD')
    return publicResponse(url,{headers:{'content-length':'700000','content-type':'application/vnd.android.package-archive','content-disposition':'attachment; filename="large.apk"'}})
  })
  assert.deepEqual(calls,['HEAD']);assert.equal(result.sha256,fastPackage.sha256)
  assert.equal(result.verification,'uploaded-hash-and-public-headers');assert.deepEqual(result.uploadProof,fastReceipt)
})

test('a provider rejecting HEAD falls back to one-byte range headers',async()=>{
  const {probePublicAsset}=await import('../download_release_asset.mjs')
  const calls=[]
  await probePublicAsset(fastPackage,fastChannel,fastReceipt,async(url,options)=>{
    calls.push(options.method)
    if(options.method==='HEAD') return publicResponse(url,{status:405})
    assert.equal(options.headers.Range,'bytes=0-0')
    return publicResponse(url,{status:206,headers:{'content-range':'bytes 0-0/700000','content-type':'application/vnd.android.package-archive'}})
  })
  assert.deepEqual(calls,['HEAD','GET'])
})

test('a matching uploaded hash cannot hide broken links, wrong sizes or apk.zip filenames',async()=>{
  const {probePublicAsset}=await import('../download_release_asset.mjs')
  for(const options of [{status:404},{headers:{'content-length':'699999'}},{headers:{'content-length':'700000','content-disposition':'attachment; filename="large.apk.zip"'}},{headers:{'content-length':'700000','content-type':'text/html'}}]) {
    await assert.rejects(probePublicAsset(fastPackage,fastChannel,fastReceipt,async url=>publicResponse(url,options)))
  }
  let networkCalls=0
  await assert.rejects(probePublicAsset(fastPackage,fastChannel,{...fastReceipt,sha256:'c'.repeat(64)},()=>{networkCalls++}))
  assert.equal(networkCalls,0)
})

for(const full of [false,true]) test(`publisher uses upload proofs with explicit full-audit=${full}`,async t=>{
  const {plan,report,preload}=await fixture(t,false)
  const data=JSON.parse(await readFile(plan,'utf8')),proof=report+'.uploads'
  const verifiedAssets={}
  for(const p of data.manifest.platforms)for(const c of p.channels)verifiedAssets[c.id+':'+p.file]={channel:c.id,releaseId:1,assetId:2,name:p.file,size:p.size,sha256:p.sha256,method:c.id==='github'?'server-sha256':'downloaded-sha256'}
  await writeFile(proof,JSON.stringify({planDigest:'a'.repeat(64),verifiedAssets}))
  await writeFile(preload,`globalThis.fetch=async(url,options)=>{if(${full?'true':'false'}){if(options.method==='HEAD')throw Error('Audit must read bytes')}else if(options.method!=='HEAD')throw Error('Fast mode must not download package');const r=new Response(options.method==='HEAD'?null:'package',{headers:{'content-length':'7'}});Object.defineProperty(r,'url',{value:url});return r}`)
  await run(process.execPath,['--import',preload,resolve('scripts/verify_release_downloads.mjs'),plan,report,'a'.repeat(64),'--upload-proof',proof,...(full?['--full-download']:[])])
  const output=JSON.parse(await readFile(report,'utf8'))
  assert.equal(output.results.length,8)
  assert.ok(output.results.every(r=>r.verification===(full?'full-download':'uploaded-hash-and-public-headers')))
})

test('verified checkpoints resume without repeating completed public probes',async t=>{
  const {plan,report,preload}=await fixture(t,false)
  const data=JSON.parse(await readFile(plan,'utf8')),p=data.manifest.platforms[0],c=p.channels[0]
  await writeFile(report+'.partial',JSON.stringify({planDigest:'a'.repeat(64),results:[{url:c.url,size:p.size,sha256:p.sha256,verification:'full-download'}]}))
  await writeFile(preload,`globalThis.fetch=async url=>{if(url===${JSON.stringify(c.url)})throw Error('Completed probe must not repeat');const r=new Response('package');Object.defineProperty(r,'url',{value:url});return r}`)
  await run(process.execPath,['--import',preload,resolve('scripts/verify_release_downloads.mjs'),plan,report,'a'.repeat(64)])
  assert.equal(JSON.parse(await readFile(report,'utf8')).results.length,8)
})

test('curl header fallback handles proxy redirects without downloading a package',async()=>{
  const {curlPublicHeaders}=await import('../download_release_asset.mjs')
  const response=await curlPublicHeaders('https://example.test/app.apk',{method:'HEAD'},async(command,args)=>{
    assert.equal(command,'curl');assert.ok(args.includes('--head'));assert.ok(args.includes('/dev/null'))
    return {stdout:'HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 302\r\nlocation: https://cdn.test/app.apk\r\n\r\nHTTP/2 200\r\ncontent-length: 700000\r\ncontent-disposition: attachment; filename="app.apk"\r\n\r\nBILIMUSIC_EFFECTIVE_URL:https://cdn.test/app.apk\n'}
  })
  assert.equal(response.status,200);assert.equal(response.url,'https://cdn.test/app.apk');assert.equal(response.headers.get('content-length'),'700000')
})

test('curl range fallback caps body size when the provider ignores Range',async()=>{
  const {curlPublicHeaders}=await import('../download_release_asset.mjs')
  const response=await curlPublicHeaders('https://example.test/app.apk',{method:'GET'},async(command,args)=>{
    assert.ok(args.includes('--range'));assert.ok(args.includes('--max-filesize'));assert.equal(args[args.indexOf('--max-filesize')+1],'1024')
    const error=new Error('Exceeded size cap');error.code=63;error.stdout='HTTP/2 200\r\ncontent-length: 700000\r\n\r\nBILIMUSIC_EFFECTIVE_URL:https://cdn.test/app.apk\n';throw error
  })
  assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),'700000')
})
