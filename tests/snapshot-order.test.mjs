import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const output=await build({entryPoints:['src/features/player/snapshotOrder.ts'],bundle:true,format:'cjs',platform:'node',write:false})
const module={exports:{}};new Function('module','exports',output.outputFiles[0].text)(module,module.exports)
const {createSnapshotOrder}=module.exports

test('driver restart accepts a reset sequence and permanently rejects the retired driver',()=>{
 const order=createSnapshotOrder()
 assert.ok(order.accept({engineInstanceId:'old',sessionId:'a',sourceRevision:99,sequence:400}))
 assert.ok(order.accept({engineInstanceId:'new',sessionId:'b',sourceRevision:1,sequence:1}))
 assert.equal(order.accept({engineInstanceId:'old',sourceRevision:100,sequence:401}),false)
 assert.equal(order.accept({revision:1000}),false)
 assert.equal(order.latest.sessionId,'b')
})
test('late source packets and reversed clock samples are rejected without losing action-only events',()=>{
 const order=createSnapshotOrder()
 assert.ok(order.accept({revision:2,sequence:4,id:'song'}))
 assert.equal(order.accept({revision:1,sequence:99}),false)
 assert.equal(order.accept({revision:2,sequence:3}),false)
 assert.ok(order.accept({action:'next'}))
 assert.equal(order.latest.sequence,4)
 assert.ok(order.accept({revision:2,sequence:5,sessionId:'repeat'}))
})
