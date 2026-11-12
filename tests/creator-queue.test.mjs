import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const compiled = await build({
  entryPoints: ['src/services/creatorQueue.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'queue-boundaries', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'invoke', namespace: 'fixture' }))
    builder.onResolve({ filter: /playerStore$/ }, () => ({ path: 'store', namespace: 'fixture' }))
    builder.onResolve({ filter: /mediaSources$/ }, () => ({ path: 'media', namespace: 'fixture' }))
    builder.onResolve({ filter: /accountScope$/ }, () => ({ path: 'account', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({path}) => ({contents: {
      invoke: 'export const invoke=(...args)=>globalThis.creatorQueueTest.invoke(...args)',
      store: 'export const usePlayerStore={subscribe(fn){globalThis.creatorQueueTest.listener=fn},getState:()=>globalThis.creatorQueueTest.state,setState(next){globalThis.creatorQueueTest.state={...globalThis.creatorQueueTest.state,...next}}}',
      media: 'export const creatorVideoRow=v=>v;export const seasonTracks=c=>c.tracks.map(v=>({id:v.bvid,source:{bvid:v.bvid}}))',
      account: 'export const accountEpoch=()=>0',
    }[path]}))
  } }],
})
function setup(invoke) {
  const fixture={state:{current:{source:{bvid:'first'}},queue:[{source:{bvid:'first'}}],queueSource:{creatorMid:42,creatorPage:1,creatorTotal:60,creatorKeyword:'钢琴',title:'UP'}},invoke}
  globalThis.creatorQueueTest=fixture
  const module={exports:{}}
  new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
  module.exports.startCreatorQueue()
  return fixture
}
const response={data:{list:{vlist:[{bvid:'next'}]},page:{count:60}}}
test('creator playback continues paging with the selected creator and search keyword', async () => {
  let args
  const f=setup(async (command,input)=>{assert.equal(command,'bili_creator_catalog');args=input;return response})
  await f.listener(f.state)
  assert.deepEqual(args,{action:'videos',mid:42,page:2,keyword:'钢琴'})
  assert.equal(f.state.queue.at(-1).id,'next')
  assert.equal(f.state.queueSource.creatorKeyword,'钢琴')
  assert.equal(f.state.queueSource.creatorPage,2)
})
test('a previous keyword request cannot append videos after switching to another search queue', async () => {
  let finish
  const f=setup(()=>new Promise(resolve=>{finish=resolve}))
  const pending=f.listener(f.state)
  f.state={...f.state,queueSource:{...f.state.queueSource,creatorKeyword:'爵士'}}
  finish(response);await pending
  assert.equal(f.state.queue.length,1)
  assert.equal(f.state.queueSource.creatorKeyword,'爵士')
})
