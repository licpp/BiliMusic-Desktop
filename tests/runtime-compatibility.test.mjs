import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createContext, runInContext } from 'node:vm'
import { readFile } from 'node:fs/promises'

const bundle = async path => (await build({entryPoints:[path],bundle:true,write:false,platform:'browser',format:'cjs',banner:{js:'"use strict";'}})).outputFiles[0].text
const compatibility = await bundle('src/shared/runtimeCompatibility.ts')
const queue = await bundle('src/features/player/queueGroups.ts')
const legacy = () => {
  const context = createContext({module:{exports:{}}})
  runInContext('delete Array.prototype.at; delete Object.hasOwn',context)
  return context
}
const tracks = `[{id:'one',resolveParts:true,source:{provider:'bilibili',bvid:'BV1'}},{id:'two',source:{provider:'bilibili',bvid:'BV1'}}]`

test('old WebKit reproduces the playback queue exception, including a restored hidden queue', () => {
  const context = legacy()
  runInContext(queue,context)
  runInContext('globalThis.presentQueue=module.exports.presentQueue',context)
  assert.throws(() => runInContext(`presentQueue(${tracks},'season')`,context),/at is not a function/)
  runInContext(compatibility,context)
  for (let restore=0;restore<2;restore++) {
    assert.equal(runInContext(`presentQueue(${tracks},'season').groups[0].tracks.length`,context),2)
  }
})
test('fallbacks preserve relative indexing and safe own-property detection', () => {
  const context=legacy();runInContext(compatibility,context)
  for(const expression of [
    '[1,2,3].at(-1)===3','[1,2,3].at(-2)===2','[1,2,3].at(1.9)===2','[1,2,3].at(-1.9)===3',
    '[1,2].at(-3)===undefined','[].at(-1)===undefined','[1].at(Infinity)===undefined','[1].at(-Infinity)===undefined',
    '[1].at(NaN)===1', 'Array.prototype.at.call({0:"x",length:1},-1)==="x"',
    'Array.prototype.at.call("abc",-1)==="c"', '!Object.keys([]).includes("at")',
    'Object.hasOwn({x:1},"x")','!Object.hasOwn({},"toString")','Object.hasOwn(Object.assign(Object.create(null),{x:1}),"x")',
    'Object.hasOwn({hasOwnProperty:null,x:1},"x")',
  ]) assert.equal(runInContext(expression,context),true,expression)
  for(const expression of ['Array.prototype.at.call(null,0)','Object.hasOwn(null,"x")','[1].at(1n)'])assert.throws(()=>runInContext(expression,context),/TypeError|Cannot|requires|BigInt/)
})
test('modern engines retain their native APIs and both entries initialize compatibility first',async()=>{
  const context=createContext({module:{exports:{}}});runInContext('globalThis.originalAt=Array.prototype.at;globalThis.originalOwn=Object.hasOwn',context)
  runInContext(compatibility,context);assert.equal(runInContext('originalAt===Array.prototype.at && originalOwn===Object.hasOwn',context),true)
  for(const path of ['src/main.tsx','src/large-screen/main.tsx'])assert.match(await readFile(path,'utf8'),/^import ['"].*runtimeCompatibility['"]/)
})
