import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {build} from 'esbuild'
const fixture=JSON.parse(await readFile('tests/fixtures/queue-visibility-order.json','utf8'))
for(const [name,path] of [['shared','src/domain/contentVisibility.ts'],['Harmony','native/ohos-player/ohos/NativeQueue.ets']])test(`${name} continues after the hidden audible row instead of jumping to the start`,async()=>{
 const built=await build({entryPoints:[path],bundle:true,write:false,format:'cjs',loader:{'.ets':'ts'},resolveExtensions:['.ets','.ts']})
 const m={exports:{}};new Function('module','exports',built.outputFiles[0].text)(m,m.exports)
 for(const item of fixture){
  let result
  if(name==='shared')result=m.exports.orderedQueueTarget(item.order,item.visible,item.current,item.direction,!item.ended||item.repeat==='all')
  else {const q=new m.exports.NativeQueue();q.update({entryOrder:item.order,tracks:item.visible.map(id=>({id,title:id,durationSeconds:120,source:{provider:'bilibili',bvid:'BV',cid:Number(id),page:1}})),repeatMode:item.repeat,shuffled:false,accountSession:'a',owner:'w',version:1});result=q.target(item.current,item.direction,item.ended)?.id}
  assert.equal(result??null,item.result,JSON.stringify(item))
 }
})
test('Swift follows the same hidden audible row order fixture',{skip:process.platform!=='darwin'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bilimusic-queue-order-'))
 try{
  await writeFile(join(dir,'main.swift'),`import Foundation
let cases=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [[String:Any]]
for item in cases {
 let result=orderedQueueTarget(item["order"] as! [String],item["visible"] as! [String],item["current"] as! String,item["direction"] as! Int,!(item["ended"] as! Bool) || item["repeat"] as! String == "all")
 precondition(result == item["result"] as? String)
}
print("matched")`)
  execFileSync('xcrun',['swiftc','native/ios-player/ios/Sources/QueueOrder.swift',join(dir,'main.swift'),'-o',join(dir,'order')],{stdio:'pipe'})
  assert.match(execFileSync(join(dir,'order'),[resolve('tests/fixtures/queue-visibility-order.json')],{encoding:'utf8'}),/matched/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
