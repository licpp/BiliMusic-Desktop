import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises'
import{tmpdir}from'node:os'
import{join,resolve}from'node:path'
import{execFileSync}from'node:child_process'
import{build}from'esbuild'
const fixture=JSON.parse(await readFile('tests/fixtures/shuffle.json','utf8'))
for(const [name,path]of[['shared','src/domain/shuffle.ts'],['Harmony','native/ohos-player/ohos/NativeQueue.ets']])test(`${name} shuffle matches the portable fixture with round boundaries, history and queue edits`,async()=>{
 const built=await build({entryPoints:[path],bundle:true,write:false,format:'cjs',loader:{'.ets':'ts'},resolveExtensions:['.ets','.ts']})
 const m={exports:{}};new Function('module','exports',built.outputFiles[0].text)(m,m.exports)
 let seed=fixture.seed;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296)
 // Harmony imports the actual shared class. Verify source identity as well as its queue integration below.
 if(name==='Harmony'){
  assert.match(await readFile(path,'utf8'),/import \{ ShuffleDeck, ShuffleItem \} from '\.\.\/\.\.\/\.\.\/src\/domain\/shuffle'/)
  const q=new m.exports.NativeQueue();let current='0';const seen=[current]
  q.update({tracks:fixture.items.map(i=>({...i,title:i.id,durationSeconds:20,source:{provider:'bilibili',bvid:i.bvid,cid:1,page:1}})),repeatMode:'all',shuffled:true,accountSession:'a',owner:'web',version:1})
  for(let i=1;i<12;i++){current=q.target(current,1,false).id;seen.push(current)}
  assert.equal(new Set(seen).size,12);assert.equal(q.target(current,-1,false).id,seen.at(-2));return
 }
 const d=new m.exports.ShuffleDeck(random)
 for(const op of fixture.operations){if(op===fixture.operations[35])d.observe(fixture.items.filter(i=>op.ids.includes(i.id)),op.current);assert.equal(d.target(fixture.items.filter(i=>op.ids.includes(i.id)),op.current,op.direction),op.result)}
})
test('Swift uses the same shuffle fixture as desktop and Android',{skip:process.platform!=='darwin'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bilimusic-shuffle-'))
 try{
 await writeFile(join(dir,'main.swift'),`import Foundation
let f=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any]
let items=(f["items"] as! [[String:Any]]).map{ShuffleItem(id:$0["id"] as! String,artist:$0["artist"] as! String,bvid:$0["bvid"] as! String)}
var seed=UInt32(f["seed"] as! Int)
let d=ShuffleDeck(random:{seed=seed &* 1664525 &+ 1013904223;return Double(seed)/4294967296})
for (index,op) in (f["operations"] as! [[String:Any]]).enumerated(){
 let queue=items.filter{(op["ids"] as! [String]).contains($0.id)},current=op["current"] as! String
 if index==35{d.observe(queue,current)}
 let result=d.target(queue,current,op["direction"] as! Int)
 precondition(result==op["result"] as? String,"Shuffle differs at operation \\(index): \\(String(describing:result))")
}
print("70 operations matched")`)
 execFileSync('xcrun',['swiftc','native/ios-player/ios/Sources/ShuffleDeck.swift',join(dir,'main.swift'),'-o',join(dir,'shuffle')],{stdio:'pipe'})
 assert.match(execFileSync(join(dir,'shuffle'),[resolve('tests/fixtures/shuffle.json')],{encoding:'utf8'}),/70 operations matched/)
 }finally{await rm(dir,{force:true,recursive:true})}
})
test('autonomous native drivers route foreground next and previous into the same queue as system controls',async()=>{
 const swift=await readFile('native/ios-player/ios/Sources/PlayerPlugin.swift','utf8')
 assert.match(swift,/case "next": advance\(1\)/);assert.match(swift,/case "previous": advance\(-1\)/)
 const android=await readFile('native/android-player/android/src/main/java/PlaybackService.kt','utf8')
 assert.match(android,/"next" -> advance\(1\)/);assert.match(android,/"previous" -> advance\(-1\)/)
 const harmony=await readFile('native/ohos-player/ohos/PlayerPlugin.ets','utf8')
 assert.match(harmony,/case 'next': await this.advance\(1\)/);assert.match(harmony,/case 'previous': await this.advance\(-1\)/)
})
