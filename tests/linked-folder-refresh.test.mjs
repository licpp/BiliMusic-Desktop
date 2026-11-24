import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {QueryClient} from '@tanstack/react-query'
const {outputFiles}=await build({entryPoints:['src/services/linkedFolders.ts'],bundle:true,write:false,format:'esm',plugins:[{name:'native-mocks',setup(b){b.onResolve({filter:/\.\/desktopApi$/},()=>({path:'api',namespace:'mock'}));b.onResolve({filter:/\.\/accountScope$/},()=>({path:'scope',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='api'?'export const refreshLinkedFolder=(...args)=>globalThis.linkedRefresh(...args)':'export const accountEpoch=()=>globalThis.linkedEpoch',loader:'js'}))}}]})
const {reloadLinkedFolder,linkedFolderKey,linkedRefreshKey,loadStaleLinkedFolder}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function setup(){globalThis.linkedEpoch=(globalThis.linkedEpoch||0)+1;const client=new QueryClient({defaultOptions:{queries:{retry:false}}});client.setQueryData(linkedFolderKey(1),{videos:['cached']});return client}
test('opening shows cached content while fetching; concurrent opens share one request and replace once complete',async()=>{
 const client=setup(),remote=deferred();let calls=0;globalThis.linkedRefresh=()=>{calls++;return remote.promise}
 const one=reloadLinkedFolder(client,1),two=reloadLinkedFolder(client,1);assert.equal(one,two);assert.equal(calls,1);assert.deepEqual(client.getQueryData(linkedFolderKey(1)).videos,['cached'])
 remote.resolve({videos:['new','complete']});await one;assert.deepEqual(client.getQueryData(linkedFolderKey(1)).videos,['new','complete']);client.clear()
})
test('failed refresh preserves cache and a later entry can retry immediately',async()=>{
 const client=setup();globalThis.linkedRefresh=async()=>{throw Error('offline')};await assert.rejects(reloadLinkedFolder(client,1),/offline/);assert.deepEqual(client.getQueryData(linkedFolderKey(1)).videos,['cached'])
 globalThis.linkedRefresh=async()=>({videos:['retry']});await reloadLinkedFolder(client,1);assert.deepEqual(client.getQueryData(linkedFolderKey(1)).videos,['retry']);client.clear()
})
test('a slow pending disk read cannot overwrite fresh network contents',async()=>{
 const client=setup(),disk=deferred();const pending=client.fetchQuery({queryKey:linkedFolderKey(1),queryFn:()=>disk.promise}).catch(()=>{});globalThis.linkedRefresh=async()=>({videos:['fresh']});await reloadLinkedFolder(client,1);disk.resolve({videos:['stale disk']});await pending;assert.deepEqual(client.getQueryData(linkedFolderKey(1)).videos,['fresh']);client.clear()
})
test('account switching drops completed refresh from previous account',async()=>{
 const client=setup(),remote=deferred();globalThis.linkedRefresh=()=>remote.promise;const oldKey=linkedFolderKey(1);const pending=reloadLinkedFolder(client,1);globalThis.linkedEpoch++;remote.resolve({videos:['other account']});await pending;assert.deepEqual(client.getQueryData(oldKey).videos,['cached']);assert.equal(client.getQueryData(linkedFolderKey(1)),undefined);client.clear()
})
test('automatic refresh waits until a completed snapshot is stale, while a manual refresh starts immediately', async () => {
 const client = setup()
 const now = 1_768_000_000_000
 client.setQueryData(linkedFolderKey(1), { videos: ['cached'], refreshedAt: now / 1000 })
 const modes = []
 globalThis.linkedRefresh = async (_folder, _link, background) => {
   modes.push(background)
   return { videos: ['updated'], refreshedAt: now / 1000 }
 }
 assert.equal(loadStaleLinkedFolder(client, 1, now + 299_000), undefined)
 await loadStaleLinkedFolder(client, 1, now + 300_000)
 await reloadLinkedFolder(client, 1)
 assert.deepEqual(modes, [true, false])
 client.clear()
})
test('status shows the number read without putting any partial data in the folder cache', async () => {
 const client = setup()
 const remote = deferred()
 const now = 1_768_000_000_000
 const limit = { code: 'bili_rate_limited', retryAt: now + 60_000 }
 let report
 globalThis.linkedRefresh = (_folder, _link, _background, progress) => { report = progress; return remote.promise }
 const running = loadStaleLinkedFolder(client, 1, now)
 report(20)
 assert.deepEqual(client.getQueryData(linkedRefreshKey(1)), { refreshing: true, read: 20 })
 assert.deepEqual(client.getQueryData(linkedFolderKey(1)).videos, ['cached'])
 remote.reject(limit)
 await assert.rejects(running, cause => cause === limit)
 report(40)
 assert.deepEqual(client.getQueryData(linkedRefreshKey(1)), { refreshing: false, read: 20, error: limit })
 assert.equal(loadStaleLinkedFolder(client, 1, now + 59_000), undefined)
 client.clear()
})
test('reopening a folder requiring verification waits for an explicit continue', async () => {
 const client = setup()
 const now = 1_768_000_000_000
 client.setQueryData(linkedRefreshKey(1), { refreshing: false, read: 4, error: { code: 'bili_verification_required' } })
 let requests = 0
 globalThis.linkedRefresh = async () => { requests++; return { videos: ['updated'] } }
 assert.equal(loadStaleLinkedFolder(client, 1, now), undefined)
 await reloadLinkedFolder(client, 1)
 assert.equal(requests, 1)
 client.clear()
})
