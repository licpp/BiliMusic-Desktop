import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
async function module(path){const r=await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'node'});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)}
const {automaticLyricQueries,automaticLyricQuery}=await module('src/features/lyrics/lyricQuery.ts')
test('编号标题兼容歌名在前和歌手在前，已填歌手优先，数字歌名保留',()=>{
 assert.deepEqual(automaticLyricQuery({title:'001. 晴天 - 周杰伦',artist:'周杰伦'}),{title:'晴天',artist:'周杰伦'})
 assert.deepEqual(automaticLyricQuery({title:'周杰伦 - 晴天',artist:'周杰伦'}),{title:'晴天',artist:'周杰伦'})
 assert.deepEqual(automaticLyricQueries({title:'001. 晴天 - 周杰伦'}),[{title:'晴天',artist:'周杰伦'},{title:'周杰伦',artist:'晴天'}])
 assert.equal(automaticLyricQuery({title:'1979'}).title,'1979')
})
