import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const out=await build({entryPoints:['src/shared/listeningDuration.ts','src/services/collectionTrack.ts'],outdir:'out',bundle:true,write:false,format:'cjs',platform:'node'})
function load(name){const module={exports:{}};new Function('require','module','exports',out.outputFiles.find(f=>f.path.endsWith(name+'.js')).text)(createRequire(import.meta.url),module,module.exports);return module.exports}
const {listeningDuration,listeningTimeParts}=load('listeningDuration'),{toTrack}=load('collectionTrack')
test('listening duration stays compact across hour and minute boundaries',()=>{
 for(const [seconds,label] of [[0,'0秒'],[59,'59秒'],[60,'1分'],[3599,'59分'],[3600,'1时0分'],[5340,'1时29分'],[3600000,'1000时0分']])assert.equal(listeningDuration(seconds),label)
})
test('multipart tracks use part title while single videos retain their actual video title',()=>{
 const part={cid:1,page:1,title:'一、乾隆择储',durationSeconds:20};const detail={bvid:'BVtest',title:'视频标题',parts:[part]}
 assert.equal(toTrack(detail,part).title,'视频标题')
 assert.equal(toTrack({...detail,parts:[part,{...part,cid:2,page:2}]},part).title,part.title)
})

test('zero and floating point residue never render a negative summary duration',()=>{
 for(const seconds of [0,-0,-Number.MIN_VALUE,-0.000000001,-1,NaN,Infinity]) {
  const value=listeningTimeParts(seconds)
  assert.equal(value.value.toLocaleString(),'0')
  assert.equal(value.unit,'分钟')
  assert.equal(value.minutes,null)
 }
 assert.deepEqual(listeningTimeParts(5340),{value:1,unit:'小时',minutes:29})
})
