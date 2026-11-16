import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const result=await build({stdin:{contents:"export * from './src/services/queryKeys'; export * from './src/services/accountScope'; export {QueryClient} from '@tanstack/react-query'",resolveDir:process.cwd()},bundle:true,format:'cjs',platform:'node',write:false})
const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
const api=module.exports

test('account cache excludes late old results and keeps public metadata through A -> B -> A',async()=>{
 globalThis.window=new EventTarget()
 const client=new api.QueryClient({defaultOptions:{queries:{retry:false}}}),dispose=api.installAccountQueryScope(client)
 client.setQueryData(['video-detail','BV123'],{title:'public'})
 let finish
 const oldKey=api.accountQueryKey('library')
 const pending=client.fetchQuery({queryKey:oldKey,queryFn:()=>new Promise(resolve=>finish=resolve)}).catch(()=>undefined)
 api.advanceAccountEpoch()
 const second=api.accountQueryKey('library');client.setQueryData(second,['B'])
 api.advanceAccountEpoch()
 const third=api.accountQueryKey('library');client.setQueryData(third,['A-new'])
 finish(['A-old']);await pending
 assert.equal(client.getQueryData(oldKey),undefined)
 assert.equal(client.getQueryData(second),undefined)
 assert.deepEqual(client.getQueryData(third),['A-new'])
 assert.equal(client.getQueryData(['video-detail','BV123']).title,'public')
 assert.notDeepEqual(oldKey,third)
 dispose();client.clear()
})
