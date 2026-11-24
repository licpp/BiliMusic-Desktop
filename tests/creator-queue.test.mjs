import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const compiled = await build({
  entryPoints: ['src/features/player/creatorQueue.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'queue-boundaries', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'invoke', namespace: 'fixture' }))
    builder.onResolve({ filter: /playerStore$/ }, () => ({ path: 'store', namespace: 'fixture' }))
    builder.onResolve({ filter: /mediaSources$/ }, () => ({ path: 'media', namespace: 'fixture' }))
    builder.onResolve({ filter: /accountScope$/ }, () => ({ path: 'account', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({path}) => ({contents: {
      invoke: 'export const invoke=(...args)=>globalThis.creatorQueueTest.invoke(...args)',
      store: `
        export const usePlayerStore = {
          subscribe(fn) {
            const fixture = globalThis.creatorQueueTest
            fixture.listener = fn
            return () => { fixture.listener = undefined }
          },
          getState: () => globalThis.creatorQueueTest.state,
        }
        export function appendCreatorQueuePage(expected, tracks, total) {
          const fixture = globalThis.creatorQueueTest
          fixture.commits.push({ expected, tracks, total })
          return fixture.state.queueSource === expected.source
        }
      `,
      media: 'export const creatorVideoRow=v=>({id:v.bvid,source:{bvid:v.bvid}})',
      account: 'export const accountEpoch=()=>0',
    }[path]}))
  } }],
})
function setup(invoke) {
  const fixture={state:{current:{source:{bvid:'first'}},queue:[{source:{bvid:'first'}}],queueSource:{creatorMid:42,creatorPage:1,creatorTotal:60,creatorKeyword:'钢琴',title:'UP'}},invoke,commits:[]}
  globalThis.creatorQueueTest=fixture
  const module={exports:{}}
  new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
  fixture.stop = module.exports.startCreatorQueue()
  return fixture
}
const response={data:{list:{vlist:[{bvid:'next'}]},page:{count:60}}}
test('creator playback continues paging with the selected creator and search keyword', async () => {
  let args
  const f=setup(async (command,input)=>{assert.equal(command,'bili_creator_catalog');args=input;return response})
  await f.listener(f.state)
  assert.deepEqual(args,{action:'videos',mid:42,page:2,keyword:'钢琴'})
  assert.deepEqual(f.commits, [{ expected: { source: f.state.queueSource, page: 1, epoch: 0 }, tracks: [{ id: 'next', source: { bvid: 'next' } }], total: 60 }])
})
test('a newly selected search queue starts its own request after the old request completes', async () => {
  const requests = []
  const f = setup((command, input) => new Promise(resolve => { requests.push({ input, resolve }) }))
  const originalSource = f.state.queueSource
  const pending=f.listener(f.state)
  f.state={...f.state,queueSource:{...f.state.queueSource,creatorKeyword:'爵士'}}
  await f.listener(f.state)
  assert.equal(requests.length, 1)
  requests[0].resolve(response)
  await pending
  assert.equal(f.commits[0].expected.source, originalSource)
  assert.deepEqual(requests.map(({ input }) => input.keyword), ['钢琴', '爵士'])
  requests[1].resolve(response)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.commits[1].expected.source, f.state.queueSource)
})

test('creator queue disposal releases its subscription and ignores a catalog reply already in flight', async () => {
  let finish
  const f = setup(() => new Promise(resolve => { finish = resolve }))
  const pending = f.listener(f.state)
  f.stop()
  finish(response)
  await pending
  assert.equal(f.listener, undefined)
  assert.equal(f.commits.length, 0)
})
