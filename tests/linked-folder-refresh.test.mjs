import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {QueryClient} from '@tanstack/react-query'
const {outputFiles}=await build({entryPoints:['src/services/linkedFolders.ts'],bundle:true,write:false,format:'esm',plugins:[{name:'native-mocks',setup(b){b.onResolve({filter:/\.\/desktopApi$/},()=>({path:'api',namespace:'mock'}));b.onResolve({filter:/\.\/accountScope$/},()=>({path:'scope',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='api'?'export const refreshLinkedFolder=(...args)=>globalThis.linkedRefresh(...args)':'export const accountEpoch=()=>globalThis.linkedEpoch',loader:'js'}))}}]})
const {reloadLinkedFolder,linkedFolderKey}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
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
 const client=setup(),remote=deferred();globalThis.linkedRefresh=()=>remote.promise;const pending=reloadLinkedFolder(client,1);globalThis.linkedEpoch++;remote.resolve({videos:['other account']});await pending;assert.deepEqual(client.getQueryData(linkedFolderKey(1)).videos,['cached']);client.clear()
})
