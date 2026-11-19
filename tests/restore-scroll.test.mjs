import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const code=(await build({entryPoints:['src/shared/restoreScroll.ts'],bundle:true,write:false,format:'esm'})).outputFiles[0].text
const {restoreScroll}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
test('return restores after layout grows and user input stops restoration',()=>{
 const frames=new Map();let id=0,resize
 globalThis.requestAnimationFrame=fn=>{frames.set(++id,fn);return id}
 globalThis.cancelAnimationFrame=i=>frames.delete(i)
 globalThis.ResizeObserver=class{constructor(fn){resize=fn}observe(){}disconnect(){}}
 const host=Object.assign(new EventTarget(),{children:[{}],height:100,value:0})
 Object.defineProperty(host,'scrollTop',{get(){return this.value},set(n){this.value=Math.min(n,this.height)}})
 const stop=restoreScroll(host,650)
 assert.equal(host.scrollTop,100)
 const paint=()=>{const work=[...frames.values()];frames.clear();work.forEach(fn=>fn())}
 paint();assert.equal(host.scrollTop,100)
 host.height=1000;resize();paint();assert.equal(host.scrollTop,650)
 host.dispatchEvent(new Event('touchstart'));host.scrollTop=200;resize();assert.equal(host.scrollTop,200)
 stop()
})
