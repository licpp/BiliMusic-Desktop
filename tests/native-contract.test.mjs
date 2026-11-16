import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {build} from 'esbuild'
const fixture=JSON.parse(await readFile(new URL('./fixtures/native-playback.json',import.meta.url),'utf8'))
const built=await build({entryPoints:['src/features/player/contracts.ts'],write:false,bundle:true,format:'cjs'})
const m={exports:{}};new Function('module','exports',built.outputFiles[0].text)(m,m.exports)
test('shared snapshot preserves zero plays, part metadata and separate driver/session/source identities',()=>{
 assert.deepEqual(m.exports.normalizeNativeSnapshot(fixture),fixture)
 const legacy=m.exports.normalizeNativeSnapshot({id:'a',revision:3})
 assert.equal(legacy.sourceRevision,3);assert.equal(legacy.capabilities.autonomousQueue,false)
})
test('iOS Codable roundtrip preserves the same shared track fixture',{skip:process.platform!=='darwin'&&'Swift compiler runs in macOS native checks'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bilimusic-contract-'))
 try{
  await writeFile(join(dir,'main.swift'),`import Foundation
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let value = try JSONSerialization.jsonObject(with:data) as! [String:Any]
let track = try JSONDecoder().decode(QueueTrack.self, from: JSONSerialization.data(withJSONObject:value["track"]!))
var state = PlayerSnapshot()
state.engineInstanceId = value["engineInstanceId"] as! String
state.sessionId = value["sessionId"] as! String
state.sourceRevision = Int64(value["sourceRevision"] as! Int)
state.sequence = Int64(value["sequence"] as! Int)
state.track = track
FileHandle.standardOutput.write(try JSONEncoder().encode(state))
`)
  execFileSync('xcrun',['swiftc','native/ios-player/ios/Sources/PlaybackContract.swift',join(dir,'main.swift'),'-o',join(dir,'contract')],{stdio:'pipe'})
  const actual=JSON.parse(execFileSync(join(dir,'contract'),[resolve('tests/fixtures/native-playback.json')],{encoding:'utf8'}))
  assert.deepEqual(actual.track,fixture.track)
  for(const key of ['engineInstanceId','sessionId','sourceRevision','sequence'])assert.equal(actual[key],fixture[key])
 }finally{await rm(dir,{recursive:true,force:true})}
})
