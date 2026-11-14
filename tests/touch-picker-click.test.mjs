import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const out=await build({entryPoints:['src/shared/consumeTouchClick.ts'],bundle:true,write:false,format:'cjs',platform:'node'}),module={exports:{}}
new Function('require','module','exports',out.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
const {consumeTouchClick}=module.exports
function click(x=100,y=200,detail=1){return Object.assign(new Event('click',{cancelable:true}),{clientX:x,clientY:y,detail})}
test('the synthetic click cannot activate an underlying control after the picker disappears',()=>{
 const target=new EventTarget();const clear=consumeTouchClick({clientX:100,clientY:200},target)
 let timerOpened=false;target.addEventListener('click',()=>timerOpened=true)
 const ghost=click();target.dispatchEvent(ghost)
 assert.equal(ghost.defaultPrevented,true);assert.equal(timerOpened,false)
 target.dispatchEvent(click());assert.equal(timerOpened,true);clear()
})
test('a fresh tap, unrelated click, and keyboard action remain available',()=>{
 const target=new EventTarget();let clear=consumeTouchClick({clientX:100,clientY:200},target)
 const keyboard=click(0,0,0);target.dispatchEvent(keyboard);assert.equal(keyboard.defaultPrevented,false)
 target.dispatchEvent(new Event('pointerdown'));const fresh=click();target.dispatchEvent(fresh);assert.equal(fresh.defaultPrevented,false);clear()
 clear=consumeTouchClick({clientX:100,clientY:200},target);const elsewhere=click(400,500);target.dispatchEvent(elsewhere);assert.equal(elsewhere.defaultPrevented,false);clear()
})
