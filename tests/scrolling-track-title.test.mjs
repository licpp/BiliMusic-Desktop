import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const output=await build({stdin:{contents:`export {ScrollingTrackTitle} from './src/features/lyrics/ScrollingTrackTitle';export {marqueeMotion,marqueeOffset,animateMarquee} from './src/shared/marquee'`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node',plugins:[{name:'title-hooks',setup(b){b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},({path})=>({path,namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='react/jsx-runtime'?'export const jsx=(type,props)=>({type,props});export const jsxs=jsx;':'export const useRef=()=>globalThis.titleFixture.ref();export const useState=()=>[false,v=>globalThis.titleFixture.scrolling=v];export const useEffect=f=>{globalThis.titleFixture.cleanup=f()};'}))}}]})
const m={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
const {marqueeMotion,marqueeOffset,animateMarquee,ScrollingTrackTitle}=m.exports

test('loop preserves first/last word holds, constant speed and the seamless copy boundary',()=>{
 for(const viewport of [80,120,200,358])for(const text of [400,900,2400]){
  const motion=marqueeMotion(viewport,text),{duration,frames:f}=motion
  assert.equal(f[0].x,0);assert.equal(f[1].x,0)
  assert.equal(f[2].x,-(text-viewport));assert.equal(f[3].x,f[2].x);assert.equal(f[4].x+text+32,0)
  assert.ok(Math.abs((f[1].offset-f[0].offset)*duration-1600)<1e-6)
  assert.ok(Math.abs((f[3].offset-f[2].offset)*duration-1100)<1e-6)
  for(const [a,b] of [[f[1],f[2]],[f[3],f[4]]])assert.ok(Math.abs((a.x-b.x)/((b.offset-a.offset)*duration)*1000-28)<1e-6)
  assert.equal(marqueeOffset(motion,1000),0)
  assert.ok(Math.abs(marqueeOffset(motion,2100)+14)<1e-6)
  assert.equal(marqueeOffset(motion,duration),0)
  assert.ok(Math.abs(marqueeOffset(motion,duration*100+2100)+14)<1e-6)
 }
 for(const [a,b]of [[0,300],[300,300],[400,200],[NaN,200],[300,Infinity]])assert.equal(marqueeMotion(a,b),null)
})
function setup({width=150,textWidth=500,hidden=false,reduced=false,enabled=true,render=true}={}){
 const names=['window','document','ResizeObserver','requestAnimationFrame','cancelAnimationFrame']
 const previous=Object.fromEntries(names.map(k=>[k,globalThis[k]]))
 const heading={clientWidth:width},original={offsetWidth:textWidth},media=new EventTarget();media.matches=reduced
 const doc=new EventTarget();doc.hidden=hidden;doc.fonts={ready:Promise.resolve()}
 const win=new EventTarget();win.matchMedia=()=>media
 const queue=new Map(),writes=[];let next=0,transform=''
 const style={get transform(){return transform},set transform(value){transform=value;writes.push(value)},removeProperty(){transform=''}}
 const track={style}
 const f=globalThis.titleFixture={scrolling:false,cleanup:null,refIndex:0,resize:null}
 f.ref=()=>({current:[heading,track,original][f.refIndex++]})
 globalThis.window=win;globalThis.document=doc
 globalThis.requestAnimationFrame=fn=>{const id=next++;queue.set(id,fn);return id}
 globalThis.cancelAnimationFrame=id=>queue.delete(id)
 globalThis.ResizeObserver=class{constructor(fn){f.resize=fn}observe(){}disconnect(){f.disconnected=true}}
 if(render)f.element=ScrollingTrackTitle({text:'完整歌名用于滚动测试',enabled})
 return {heading,media,doc,win,track,queue,writes,fixture:f,step(now){const pending=[...queue.values()];queue.clear();pending.forEach(fn=>fn(now))},x(){return Number(transform.match(/translate3d\((-?[\d.]+)px/)?.[1]??0)},finish(){f.cleanup?.();Object.assign(globalThis,previous)}}
}
test('fitting titles remain static and width changes restart or remove motion',()=>{
 const f=setup({width:550});try{
  assert.equal(f.fixture.scrolling,false);assert.equal(f.queue.size,0)
  f.heading.clientWidth=200;f.fixture.resize();assert.equal(f.fixture.scrolling,true);assert.equal(f.queue.size,1)
  f.step(0);f.step(900);f.step(1800);assert.ok(f.x()<0)
  f.heading.clientWidth=150;f.fixture.resize();assert.equal(f.x(),0);assert.equal(f.queue.size,1)
  f.heading.clientWidth=550;f.fixture.resize();assert.equal(f.fixture.scrolling,false);assert.equal(f.queue.size,0);assert.equal(f.track.style.transform,'')
  assert.equal(f.fixture.element.props.title,'完整歌名用于滚动测试');assert.equal(f.fixture.element.props.children.props.children[1].props['aria-hidden'],'true')
 }finally{f.finish()}
})
test('title advances independently each frame with no lyric events or React updates, including after foreground recovery',()=>{
 const f=setup();try{
  f.step(0);for(let t=100;t<=2000;t+=100)f.step(t)
  const before=f.x();assert.ok(before<0)
  f.doc.hidden=true;f.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(f.queue.size,0)
  f.doc.hidden=false;f.doc.dispatchEvent(new Event('visibilitychange'));f.win.dispatchEvent(new Event('focus'));f.win.dispatchEvent(new Event('pageshow'))
  assert.equal(f.queue.size,1);assert.equal(f.x(),before)
  f.step(302000);for(let t=302016;t<=302096;t+=16)f.step(t)
  assert.ok(f.x()<before-2);assert.equal(f.queue.size,1)
 }finally{f.finish()}
})
test('pagehide/pageshow and focus recover lost frame callbacks without duplicate loops or stale writes',()=>{
 const f=setup();try{
  f.step(0);f.step(900);f.step(1800);const before=f.x(),stale=[...f.queue.values()][0]
  f.queue.clear();f.win.dispatchEvent(new Event('pagehide'));assert.equal(f.queue.size,0)
  f.win.dispatchEvent(new Event('pageshow'));assert.equal(f.queue.size,1)
  stale(100000);assert.equal(f.queue.size,1);assert.equal(f.x(),before)
  f.step(100000);f.step(100050);assert.ok(f.x()<before)
  f.queue.clear();f.win.dispatchEvent(new Event('focus'));assert.equal(f.queue.size,1)
  f.step(200000);const resumed=f.x();f.step(200050);assert.ok(f.x()<resumed)
 }finally{f.finish()}
})
test('a suspended WebView without visibility events does not jump across the title',()=>{
 const f=setup();try{f.step(0);f.step(900);f.step(1800);const before=f.x();f.step(301800);assert.equal(f.x(),before);f.step(301850);assert.ok(f.x()<before)}finally{f.finish()}
})
test('a browser with a reduced frame rate still advances at the intended text speed',()=>{
 const f=setup();try{f.step(0);f.step(1000);f.step(2000);assert.ok(Math.abs(f.x()+11.2)<1e-6);f.step(3000);assert.ok(Math.abs(f.x()+39.2)<1e-6)}finally{f.finish()}
})
test('reduced motion, cleanup and delayed font completion cannot restart a disposed title',async()=>{
 const f=setup();f.media.matches=true;f.media.dispatchEvent(new Event('change'));assert.equal(f.fixture.scrolling,false);assert.equal(f.queue.size,0)
 f.media.matches=false;f.media.dispatchEvent(new Event('change'));assert.equal(f.fixture.scrolling,true)
 const late=[...f.queue.values()][0];f.fixture.cleanup();assert.equal(f.queue.size,0);assert.equal(f.fixture.disconnected,true)
 const count=f.writes.length;late(5000);f.win.dispatchEvent(new Event('focus'));f.doc.dispatchEvent(new Event('visibilitychange'));await Promise.resolve();assert.equal(f.writes.length,count);assert.equal(f.queue.size,0);f.finish()
})
test('desktop static titles, initial background and reduced-motion preferences retain content',()=>{
 for(const options of [{enabled:false},{reduced:true},{hidden:true}]){const f=setup(options);try{assert.equal(f.queue.size,0);assert.equal(f.fixture.scrolling,!!options.hidden)}finally{f.finish()}}
})
test('mini-player hover pauses the shared frame clock and foregrounding reconciles the actual pointer',()=>{
 const f=setup({render:false}),hover=new EventTarget();let hovering=false;hover.matches=()=>hovering
 const stop=animateMarquee(f.track,marqueeMotion(150,500,30),hover)
 try{f.step(0);f.step(900);f.step(1800);const before=f.x();hovering=true;hover.dispatchEvent(new Event('mouseenter'));assert.equal(f.queue.size,0)
  f.win.dispatchEvent(new Event('focus'));assert.equal(f.queue.size,0)
  hovering=false;f.win.dispatchEvent(new Event('focus'));assert.equal(f.queue.size,1);f.step(300000);assert.equal(f.x(),before);f.step(300050);assert.ok(f.x()<before)
 }finally{stop();f.finish()}
})
