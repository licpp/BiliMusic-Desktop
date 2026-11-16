import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const output=await build({entryPoints:['src/features/lyrics/ScrollingTrackTitle.tsx'],bundle:true,write:false,format:'cjs',platform:'node',plugins:[{name:'title-hooks',setup(b){b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},({path})=>({path,namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='react/jsx-runtime'?'export const jsx=(type,props)=>({type,props});export const jsxs=jsx;':'export const useRef=()=>globalThis.titleFixture.ref();export const useState=()=>[false,v=>globalThis.titleFixture.scrolling=v];export const useEffect=f=>{globalThis.titleFixture.cleanup=f()};'}))}}]})
const m={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
const {trackTitleMotion,ScrollingTrackTitle}=m.exports
const x=frame=>Number(frame.transform.match(/\((-?[\d.]+)px\)/)[1])

test('loop pauses at the start and last word and joins the next copy without reversing',()=>{
 for(const viewport of [80,120,200,358])for(const text of [400,900,2400]){
  const {duration,keyframes:f}=trackTitleMotion(viewport,text)
  assert.equal(x(f[0]),0);assert.equal(x(f[1]),0)
  assert.equal(x(f[2]),-(text-viewport));assert.equal(x(f[3]),x(f[2]));assert.equal(x(f[4])+text+32,0)
  assert.ok(Math.abs((f[1].offset-f[0].offset)*duration-1600)<1e-6)
  assert.ok(Math.abs((f[3].offset-f[2].offset)*duration-1100)<1e-6)
  for(const [a,b] of [[f[1],f[2]],[f[3],f[4]]])assert.ok(Math.abs((x(a)-x(b))/((b.offset-a.offset)*duration)*1000-28)<1e-6)
 }
 for(const [a,b]of [[0,300],[300,300],[400,200],[NaN,200],[300,Infinity]])assert.equal(trackTitleMotion(a,b),null)
})
function setup({width=150,textWidth=500,hidden=false,reduced=false,enabled=true}={}){
 const previous={window:globalThis.window,document:globalThis.document,ResizeObserver:globalThis.ResizeObserver}
 const heading={clientWidth:width},original={offsetWidth:textWidth},media=new EventTarget();media.matches=reduced
 const doc=new EventTarget();doc.hidden=hidden;doc.fonts={ready:Promise.resolve()}
 const f=globalThis.titleFixture={scrolling:false,animations:[],cleanup:null,refIndex:0}
 const track={animate(frames,options){const a={frames,options,pauses:0,plays:0,cancels:0,pause(){this.pauses++},play(){this.plays++},cancel(){this.cancels++}};f.animations.push(a);return a}}
 f.ref=()=>({current:[heading,track,original][f.refIndex++]})
 globalThis.window={matchMedia:()=>media};globalThis.document=doc
 globalThis.ResizeObserver=class{constructor(fn){f.resize=fn}observe(){}disconnect(){f.disconnected=true}}
 f.element=ScrollingTrackTitle({text:'完整歌名用于滚动测试',enabled})
 return {...f,heading,media,doc,fixture:f,finish(){f.cleanup?.();Object.assign(globalThis,previous)}}
}
test('fitting titles stay still; available width changes with three/four buttons restart or stop the loop',()=>{
 const f=setup({width:550});assert.equal(f.fixture.scrolling,false);assert.equal(f.animations.length,0)
 f.heading.clientWidth=200;f.fixture.resize();assert.equal(f.fixture.scrolling,true);assert.equal(f.animations.length,1);assert.equal(f.animations[0].options.iterations,Infinity)
 f.heading.clientWidth=150;f.fixture.resize();assert.equal(f.animations[0].cancels,1);assert.equal(f.animations.length,2)
 f.heading.clientWidth=550;f.fixture.resize();assert.equal(f.fixture.scrolling,false);assert.equal(f.animations[1].cancels,1)
 assert.equal(f.element.props.title,'完整歌名用于滚动测试');assert.equal(f.element.props.children.props.children[1].props['aria-hidden'],'true')
 f.finish()
})
test('reduced motion, backgrounding and cleanup control the animation without losing title content',()=>{
 const f=setup({hidden:true});assert.equal(f.animations[0].pauses,1)
 f.doc.hidden=false;f.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(f.animations[0].plays,1)
 f.media.matches=true;f.media.dispatchEvent(new Event('change'));assert.equal(f.fixture.scrolling,false);assert.equal(f.animations[0].cancels,1)
 f.media.matches=false;f.media.dispatchEvent(new Event('change'));assert.equal(f.fixture.scrolling,true)
 const last=f.animations.at(-1);f.finish();assert.equal(last.cancels,1);assert.equal(f.fixture.disconnected,true)
 f.doc.hidden=true;f.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(last.pauses,0)
})
test('desktop and reduced-motion views retain a static title',()=>{
 for(const options of [{enabled:false},{reduced:true}]){const f=setup(options);assert.equal(f.animations.length,0);assert.equal(f.fixture.scrolling,false);f.finish()}
})
