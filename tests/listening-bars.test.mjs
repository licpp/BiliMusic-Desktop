import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const out=await build({entryPoints:['src/features/settings/ListeningBars.tsx'],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react/jsx-runtime'],plugins:[{name:'hooks',setup(b){b.onResolve({filter:/^react$/},()=>({path:'hooks',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const useState=()=>globalThis.barsTest.state();export const useRef=()=>globalThis.barsTest.ref;export const useId=()=>"tip";export const useEffect=fn=>globalThis.barsTest.effect(fn)'}))}}]})
function find(node,predicate){if(!node||typeof node!=='object')return [];if(Array.isArray(node))return node.flatMap(n=>find(n,predicate));return [...(predicate(node)?[node]:[]),...find(node.props?.children,predicate)]}
test('hover, touch, keyboard navigation and outside dismissal share the selected day',()=>{
 let selected=null,cleanup,focused=-1
 globalThis.document=new EventTarget()
 globalThis.barsTest={state:()=>[selected,v=>selected=v],ref:{current:{contains:()=>false,querySelectorAll:()=>[0,1].map(i=>({focus:()=>focused=i}))}},effect:fn=>{if(!cleanup)cleanup=fn()}}
 const module={exports:{}};new Function('require','module','exports',out.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
 const props={bars:[{key:'2026-11-13',label:'五',seconds:5340,future:false},{key:'2026-11-14',label:'六',seconds:0,future:false}],max:5340,today:'2026-11-14',weekly:true}
 const render=()=>module.exports.ListeningBars(props)
 let buttons=find(render(),n=>n.props?.role==='button');buttons[0].props.onPointerEnter();assert.equal(selected,'2026-11-13')
 let tip=find(render(),n=>n.props?.role==='tooltip')[0];assert.match(JSON.stringify(tip),/1时29分/);assert.ok(tip.props.style.left.startsWith('clamp('))
 buttons[1].props.onPointerDown();assert.equal(selected,'2026-11-14');assert.match(JSON.stringify(find(render(),n=>n.props?.role==='tooltip')),/暂无聆听/)
 buttons[0].props.onKeyDown({key:'ArrowRight',preventDefault(){}});assert.equal(focused,1)
 buttons[1].props.onKeyDown({key:'Escape',preventDefault(){}});assert.equal(selected,null)
 buttons[0].props.onFocus();document.dispatchEvent(new Event('pointerdown'));assert.equal(selected,null)
 cleanup()
})
