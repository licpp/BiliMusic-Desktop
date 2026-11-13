import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const bundle=await build({entryPoints:['src/shared/PublishedDate.tsx'],bundle:true,write:false,format:'esm',platform:'node'})
const {publicationDate}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
test('publication dates use Unix seconds and omit absent or invalid dates',()=>{
 for(const value of [undefined,0,-1,NaN,Infinity,1e30])assert.equal(publicationDate(value),undefined)
 const seconds=1700000000,date=new Date(seconds*1000)
 assert.equal(publicationDate(seconds).iso,'2023-11-14T22:13:20.000Z')
 assert.equal(publicationDate(seconds).label,`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`)
})
