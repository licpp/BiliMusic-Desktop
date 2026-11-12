import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const output=await build({entryPoints:['src/features/lyrics/useArtworkFit.ts'],bundle:true,write:false,format:'esm',platform:'node'})
const {fitArtwork}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
test('横版和方形封面同时受可用宽高约束，保持比例而非裁切或撑出白框',()=>{
  for(const [width,height,ratio,compact] of [[320,390,16/9,false],[500,180,1,false],[342,192,1,true],[342,192,16/9,true],[342,192,2/3,true]]){
    const fit=fitArtwork(width,height,ratio,compact)
    assert.ok(fit.width<=width&&fit.height<=height)
    assert.ok(Math.abs(fit.width/fit.height-ratio)<1e-8)
  }
  assert.deepEqual(fitArtwork(342,192,1,true),{width:192,height:192})
  assert.equal(fitArtwork(0,192,1,true),undefined)
  assert.deepEqual(fitArtwork(1000,800,1,false),{width:320,height:320})
  assert.equal(fitArtwork(1000,800,16/9,false).width,480)
})
