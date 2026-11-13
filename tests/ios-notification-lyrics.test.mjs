import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
test('iOS notification lyrics follow the native clock, saved bias, subtitle gaps and track isolation without a toggle',{skip:process.platform!=='darwin'},async()=>{
 const folder=await mkdtemp(join(tmpdir(),'bilimusic-native-lyrics-'))
 try{
  await writeFile(join(folder,'main.swift'),String.raw`
import Foundation
let lyrics=NotificationLyrics()
func update(_ value:String){lyrics.update(try! JSONDecoder().decode(NativeLyricsRequest.self,from:Data(value.utf8)))}
func expect(_ position:Double,_ text:String?,id:String="a"){precondition(lyrics.line(for:id,at:position)==text,"Incorrect lyric at \(position)")}
update(#"{"action":"update","id":"a","biasMs":500,"lines":[{"timeMs":1000,"endTimeMs":2000,"text":"第一句"},{"timeMs":4000,"text":"下一句"}]}"#)
expect(1.499,nil);expect(1.5,"第一句");expect(4.499,"第一句");expect(4.5,"下一句");expect(2,"第一句");expect(2,nil,id:"b")
update(#"{"action":"update","id":"a","subtitles":true,"biasMs":0,"lines":[{"timeMs":1000,"endTimeMs":2000,"text":"AI字幕"},{"timeMs":4000,"endTimeMs":5000,"text":"第二段"}]}"#)
expect(1,"AI字幕");expect(2,nil);expect(3.9,nil);expect(4,"第二段");expect(5,nil);expect(1.5,"AI字幕")
update(#"{"action":"update","id":"b","lines":[{"timeMs":0,"text":"换歌"}]}"#)
expect(1,nil);expect(1,"换歌",id:"b");expect(.nan,nil,id:"b")
lyrics.clear();expect(1,nil,id:"b")
update(#"{"action":"update","id":"a","lines":[{"timeMs":0,"text":" "}]}"#);expect(1,nil)
print("native notification lyric cases passed")
`)
  const macSDK=execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8',env:{...process.env,DEVELOPER_DIR:'/Applications/Xcode.app/Contents/Developer'}}).trim()
  execFileSync('/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc',['-sdk',macSDK,'-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos12.0`,'native/ios-player/ios/Sources/NotificationLyrics.swift',join(folder,'main.swift'),'-o',join(folder,'cases')],{cwd:resolve('.'),timeout:60000})
  assert.match(execFileSync(join(folder,'cases'),{encoding:'utf8'}),/cases passed/)
 }finally{await rm(folder,{recursive:true,force:true})}
})
