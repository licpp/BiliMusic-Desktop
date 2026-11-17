import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const code=(await build({entryPoints:['src/large-screen/focus.ts'],bundle:true,write:false,format:'esm'})).outputFiles[0].text
const {installDirectionalFocus}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
function fixture(run){
 const saved={document:globalThis.document,window:globalThis.window,getComputedStyle:globalThis.getComputedStyle}
 const handlers=new Map(),shell={}
 let scope
 const element=(id,left,top,width=60,height=44,primary=false,input=false)=>({id,tabIndex:0,dataset:{focus:id},isConnected:true,parentElement:null,
  getAttribute:()=>null,hasAttribute:name=>name==='data-primary-focus'&&primary,
  closest:()=>null,getClientRects:()=>[{}],getBoundingClientRect:()=>({left,top,width,height}),
  matches:selector=>input&&selector.includes('input:not('),
  focus(){document.activeElement=this;handlers.get('focusin')?.({target:this})},
 })
 const close=element('close',1080,40),input=element('replacement-search',160,140,750,46,true,true),clear=element('clear',930,140,30,46),submit=element('search-submit',970,140,100,46)
 const preview1=element('preview1',160,230,156,96),use1=element('use1',1000,250,70,44,true),preview2=element('preview2',160,355,156,96),use2=element('use2',1000,375,70,44,true),cancel=element('cancel',1000,520,70,44)
 const elements=[close,input,clear,submit,preview1,use1,preview2,use2,cancel]
 scope={getClientRects:()=>[{}],closest:()=>null,querySelectorAll:()=>elements,contains:el=>elements.includes(el)}
 globalThis.document={activeElement:null,documentElement:{dataset:{}},querySelectorAll:()=>[scope],querySelector:selector=>selector==='.large-shell'?shell:null,addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener(){}}
 globalThis.window={addEventListener(){},removeEventListener(){}}
 globalThis.getComputedStyle=()=>({visibility:'visible'})
 const cleanup=installDirectionalFocus()
 const press=(target,key)=>{target.focus();handlers.get('keydown')({target,key,defaultPrevented:false,preventDefault(){}});return document.activeElement.id}
 try{run({close,input,clear,submit,preview1,use1,preview2,use2,cancel,press})}finally{cleanup();Object.assign(globalThis,saved)}
}
test('replacement dialog down navigation enters the search field and selects the next video row',()=>{
 fixture(h=>{
  assert.equal(h.press(h.close,'ArrowDown'),'replacement-search')
  assert.equal(h.press(h.input,'ArrowDown'),'use1')
  assert.equal(h.press(h.use1,'ArrowDown'),'use2')
  assert.equal(h.press(h.use2,'ArrowDown'),'cancel')
  assert.equal(h.press(h.use1,'ArrowUp'),'replacement-search')
 })
})
test('replacement preview and selection remain reachable horizontally and modal focus stays contained',()=>{
 fixture(h=>{
  assert.equal(h.press(h.use1,'ArrowLeft'),'preview1')
  assert.equal(h.press(h.preview1,'ArrowRight'),'use1')
  assert.equal(h.press(h.preview1,'ArrowLeft'),'preview1')
  assert.equal(h.press(h.input,'ArrowRight'),'clear')
  assert.equal(h.press(h.clear,'ArrowRight'),'search-submit')
 })
})
test('editing replacement keywords preserves caret navigation and down can leave the input',()=>{
 fixture(h=>{
  h.input.dataset.largeEditing='true'
  assert.equal(h.press(h.input,'ArrowLeft'),'replacement-search')
  assert.equal(h.press(h.input,'ArrowRight'),'replacement-search')
  assert.equal(h.press(h.input,'ArrowDown'),'use1')
 })
})
