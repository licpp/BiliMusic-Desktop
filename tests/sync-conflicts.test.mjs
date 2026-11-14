import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const {outputFiles}=await build({entryPoints:['src/features/sync/SyncConflicts.tsx'],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react/jsx-runtime'],plugins:[{name:'boundary',setup(b){
 b.onResolve({filter:/^(react|lucide-react|@tauri-apps\/api\/core)$|services\/desktopApi$/},a=>({path:a.path,namespace:'mock'}))
 b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='react'?`export const useState=v=>globalThis.conflictTest.state(v);export const useEffect=(f,d)=>globalThis.conflictTest.effect(f,d);`:path==='lucide-react'?`export const Check=()=>null`:path.includes('desktopApi')?`export const commandErrorMessage=e=>e.message`:`export const invoke=()=>globalThis.conflictTest.invoke()`}))
}}]})
function elements(n,p){if(!n||typeof n!=='object')return[];if(Array.isArray(n))return n.flatMap(c=>elements(c,p));return[...(p(n)?[n]:[]),...elements(n.props?.children,p)]}
function setup(){let index=0;const states=[],effects=[],pending=[],calls=[];let token='a'.repeat(64);let conflicts=[{key:'playlist:x',field:'name'},{key:'collection:up:1',field:'creatorNote'}];
 const cells=[{type:'value',value:'本机值'},{type:'value',value:'云端值'},{type:'missing'}];
 const options=Object.fromEntries(conflicts.map(c=>[JSON.stringify([c.key,c.field]),cells.map((cell,i)=>({cell,label:i===0?'本机':`云端 ${i}`}))]));
 globalThis.conflictTest={state(initial){const i=index++;if(!(i in states))states[i]=initial;return[states[i],v=>states[i]=typeof v==='function'?v(states[i]):v]},effect(fn,deps){const i=index++;if(!effects[i]||effects[i].deps.some((v,j)=>v!==deps[j])){effects[i]?.cleanup?.();effects[i]={deps};pending.push(()=>effects[i].cleanup=fn())}},invoke:async()=>({token,options})};
 const module={exports:{}};new Function('require','module','exports',outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
 const render=()=>{index=0;const tree=module.exports.SyncConflicts({conflicts,busy:false,onMerge:v=>calls.push(JSON.parse(v))});pending.splice(0).forEach(f=>f());return tree};
 const button=(text)=>elements(render(),n=>n.type==='button'&&n.props.children===text)[0];
 return{render,button,calls,cells,change(){token='b'.repeat(64);conflicts=[...conflicts]},text:module.exports.conflictText}
}
test('each field can keep a different candidate; choices need explicit submission and reset on fresh conflicts',async()=>{
 const s=setup();s.render();await new Promise(setImmediate);
 assert.equal(s.button('按选择合并并同步').props.disabled,true);
 assert.equal(s.calls.length,0);
 s.button('全部保留本机').props.onClick();
 const choices=elements(s.render(),n=>n.type==='button'&&n.props['aria-pressed']!==undefined);
 choices[2].props.onClick();
 s.button('按选择合并并同步').props.onClick();
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].token,'a'.repeat(64));
 assert.deepEqual(s.calls[0].choices,{'["playlist:x","name"]':s.cells[2],'["collection:up:1","creatorNote"]':s.cells[0]});
 s.change();s.render();await new Promise(setImmediate);
 assert.equal(s.button('按选择合并并同步').props.disabled,true);
 assert.equal(s.calls.length,1);
 s.button('全部保留云端').props.onClick();s.button('按选择合并并同步').props.onClick();
 assert.equal(s.calls[1].token,'b'.repeat(64));
})
test('missing, explicit null, and deletion have distinct readable descriptions',()=>{const s=setup();assert.equal(s.text({type:'missing'},'name'),'未设置 / 已移除');assert.equal(s.text({type:'value',value:null},'name'),'清空此项');assert.equal(s.text({type:'value',value:false},'__present'),'删除这项资料')})
