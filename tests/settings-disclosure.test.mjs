import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const output=await build({entryPoints:['src/features/settings/SettingsDisclosure.tsx'],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react/jsx-runtime'],plugins:[{name:'hooks',setup(builder){
 builder.onResolve({filter:/^react$/},()=>({path:'react',namespace:'test'}))
 builder.onResolve({filter:/^lucide-react$/},()=>({path:'icons',namespace:'test'}))
 builder.onLoad({filter:/.*/,namespace:'test'},({path})=>({contents:path==='icons'?'export const ChevronDown=()=>null':'export const useState=()=>globalThis.disclosureState();export const useEffect=fn=>globalThis.disclosureEffect=fn;export const useRef=()=>globalThis.disclosureRef'}))
}}]})
function setup(){globalThis.disclosureRef={current:null};let mounted=false;const changes=[];globalThis.disclosureState=()=>[mounted,value=>{mounted=value}];const module={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);const child={formDraft:'not discarded'};return{changes,child,render:()=>module.exports.SettingsDisclosure({icon:null,title:'云同步',description:'同步',children:child,onToggle:open=>changes.push(open)})}}
test('settings panels mount on first expansion and keep their children when collapsed',()=>{
 const {render,child}=setup()
 const initial=render();assert.equal(initial.type,'details');assert.equal(initial.props.open,undefined);assert.equal(initial.props.children[1],false)
 initial.props.onToggle({currentTarget:{open:true}})
 assert.equal(render().props.children[1].props.children,child)
 render().props.onToggle({currentTarget:{open:false}})
 assert.equal(render().props.children[1].props.children,child)
})
test('panel collapse notifies editors so keyboard recording can stop immediately',()=>{
 const {render,changes}=setup();render().props.onToggle({currentTarget:{open:true}});render().props.onToggle({currentTarget:{open:false}});assert.deepEqual(changes,[true,false])
})

test('sync navigation opens and scrolls to the disclosure without discarding its content',()=>{
 const {child}=setup();let scrolled=false;globalThis.disclosureRef.current={open:false,scrollIntoView:()=>scrolled=true}
 const module={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
 module.exports.SettingsDisclosure({icon:null,title:'云同步',description:'待处理',children:child,reveal:1})
 globalThis.disclosureEffect();assert.equal(globalThis.disclosureRef.current.open,true);assert.equal(scrolled,true)
})
