import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
// Exercise the actual canvas effect with a transformed viewport and a landscape layout.
const effects=[]
let observerCallback, orientationCallback, viewportCallback
let canvas
const output=await build({entryPoints:['src/features/lyrics/DanmakuCanvas.tsx'],bundle:true,write:false,format:'esm',jsx:'transform',jsxFactory:'globalThis.__dmJSX',plugins:[{name:'mocks',setup(b){
 b.onResolve({filter:/^react\/jsx-runtime$/},()=>({path:'jsx',namespace:'mock'}))
 b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'mock'}))
 b.onResolve({filter:/playerStore$/},()=>({path:'player',namespace:'mock'}))
 b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='jsx'?`export const jsx=()=>null;export const jsxs=()=>null;`:path==='react'?`export const memo=x=>x;export const useRef=()=>({current:globalThis.__dmCanvas});export const useEffect=f=>globalThis.__dmEffects.push(f);export const createElement=()=>null;export default {createElement}`:`export const playbackClock=()=>0;export const usePlayerStore={getState:()=>({status:'paused'}),subscribe:()=>()=>{}}`,loader:'js'}))
}}]})
globalThis.__dmJSX=()=>null
globalThis.__dmEffects=effects
const transforms=[]
canvas={clientWidth:960,clientHeight:420,getBoundingClientRect:()=>({width:420,height:960}),getContext:()=>({setTransform:(...args)=>transforms.push(args)})}
globalThis.__dmCanvas=canvas
globalThis.window={devicePixelRatio:2,addEventListener(){},removeEventListener(){},visualViewport:{addEventListener(_,f){viewportCallback=f},removeEventListener(){}}}
globalThis.screen={orientation:{addEventListener(_,f){orientationCallback=f},removeEventListener(){}}}
globalThis.document={hidden:false,addEventListener(){},removeEventListener(){}}
globalThis.ResizeObserver=class{constructor(f){observerCallback=f}observe(){}disconnect(){}}
globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}
const {DanmakuCanvas}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
test('canvas uses untransformed layout dimensions and rebuilds after orientation/DPR changes',()=>{
 DanmakuCanvas({items:[],scale:1,opacity:1,density:1});const cleanup=effects[0]()
 assert.equal(canvas.width,1920);assert.equal(canvas.height,840);assert.deepEqual(transforms.at(-1),[2,0,0,2,0,0])
 canvas.clientWidth=420;canvas.clientHeight=960;orientationCallback();assert.equal(canvas.width,840);assert.equal(canvas.height,1920)
 window.devicePixelRatio=1.5;viewportCallback();assert.equal(canvas.width,630);assert.equal(canvas.height,1440)
 canvas.clientWidth=0;observerCallback();assert.equal(canvas.width,630)
 cleanup()
})
