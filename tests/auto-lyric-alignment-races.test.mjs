import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const mocks={
 react:'export const useRef=(v)=>globalThis.alignFixture.react.useRef(v);export const useState=(v)=>globalThis.alignFixture.react.useState(v);export const useEffect=(f,d)=>globalThis.alignFixture.react.useEffect(f,d);',
 account:'export const accountEpoch=()=>globalThis.alignFixture.epoch;',
 player:'export const usePlayerStore={getState:()=>({current:globalThis.alignFixture.playback})};',
 api:'export const commandErrorMessage=String;export const setStoredLyricsBias=(...a)=>globalThis.alignFixture.save(...a);',
 alignment:'export const automaticLyricBias=(...a)=>globalThis.alignFixture.calculate(...a);',
}
const built=await build({entryPoints:['src/features/lyrics/useAutoLyricAlignment.ts'],bundle:true,write:false,format:'cjs',platform:'node',plugins:[{name:'alignment-races',setup(b){for(const[filter,path]of [[/^react$/,'react'],[/services\/accountScope$/,'account'],[/player\/playerStore$/,'player'],[/services\/desktopApi$/,'api'],[/\/autoAlignment$/,'alignment']])b.onResolve({filter},()=>({path,namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:mocks[path]}))}}]})
const m={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function setup(){
 const slots=[],effects=[];let cursor=0
 const f=globalThis.alignFixture={epoch:0,playback:{id:'a'},writes:[],applied:[],calculate:async()=>({ok:true,biasMs:2500}),save:async(id,value,expected)=>{f.writes.push({id,value,expected});return {...expected,biasMs:value}}}
 f.react={useRef(v){const i=cursor++;return slots[i]??=( {current:v})},useState(v){const i=cursor++;slots[i]??={value:typeof v==='function'?v():v};return[slots[i].value,v=>{slots[i].value=typeof v==='function'?v(slots[i].value):v}]},useEffect(fn,deps){const i=cursor++,previous=slots[i];if(!previous||deps.some((d,j)=>d!==previous.deps[j])){effects.push(()=>{previous?.cleanup?.();slots[i]={deps,cleanup:fn()}})}}}
 f.options={track:{id:'a',source:{provider:'bilibili',bvid:'BV1',cid:1}},stored:{trackId:'a',writeToken:'choice-A',biasMs:0},lines:[],enabled:true,onAligned:saved=>f.applied.push(saved)}
 f.render=()=>{cursor=0;const h=m.exports.useAutoLyricAlignment(f.options);while(effects.length)effects.shift()();return h}
 f.unmount=()=>{for(const slot of slots)slot?.cleanup?.()}
 globalThis.window=new EventTarget();globalThis.CustomEvent??=class extends Event{constructor(type,{detail}){super(type);this.detail=detail}}
 f.render();return f
}
test('automatic offset saves once with the expected lyric snapshot and ignores repeated clicks',async()=>{
 const f=setup(),calculation=deferred();f.calculate=()=>calculation.promise
 const h=f.render(),first=h.run();await h.run();assert.equal(f.writes.length,0)
 calculation.resolve({ok:true,biasMs:2500});await first
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].expected,f.options.stored);assert.equal(f.applied[0].biasMs,2500);assert.equal(f.render().busy,false);f.unmount()
})
test('account, lyric, manual bias and playback ABA changes never apply stale results',async()=>{
 for(const change of [f=>f.epoch++,f=>{f.options={...f.options,stored:{...f.options.stored,writeToken:'choice-B'}};f.render()},f=>{f.options={...f.options,stored:{...f.options.stored,biasMs:500}};f.render()},f=>{f.playback={id:'b'};f.playback={id:'a'}},f=>{f.options={...f.options,enabled:false};f.render()}]){
  const f=setup(),calculation=deferred();f.calculate=()=>calculation.promise;const pending=f.render().run();await new Promise(setImmediate);change(f);calculation.resolve({ok:true,biasMs:2500});await pending;assert.equal(f.writes.length,0);assert.equal(f.applied.length,0);f.unmount()
 }
})
test('closing during save or unmounting prevents late UI changes and late errors',async()=>{
 for(const unmount of [false,true]){
  const f=setup(),saving=deferred();let entered=false;f.save=()=>{entered=true;return saving.promise}
  const pending=f.render().run();while(!entered)await new Promise(setImmediate)
  if(unmount)f.unmount();else{f.options={...f.options,enabled:false};f.render()}
  saving.reject(new Error('old request failed'));await pending;assert.equal(f.applied.length,0)
  if(!unmount){assert.equal(f.render().message,'');f.unmount()}
 }
})
