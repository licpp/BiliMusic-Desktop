import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
test('iOS accepts both local audio and HLS, rejecting external or unexpected routes',{skip:process.platform!=='darwin'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'bilimusic-local-media-'))
 try{
  await writeFile(join(root,'main.swift'),`import Foundation
for value in ["http://127.0.0.1:1234/token/audio","http://127.0.0.1:1234/token/audio/index.m3u8"] {precondition(validatedLocalMediaURL(value) != nil)}
for value in ["https://127.0.0.1:1234/token/audio","http://localhost:1234/token/audio","http://127.0.0.1/token/audio","http://user:pass@127.0.0.1:1234/token/audio","http://127.0.0.1:1234/token/audio/other","http://127.0.0.1:1234/token/audio/index.m3u8/extra","http://127.0.0.1:0/token/audio","http://127.0.0.1:1234/token/audio?url=external"] {precondition(validatedLocalMediaURL(value)==nil,value)}
print("validated")`)
  execFileSync('xcrun',['swiftc','native/ios-player/ios/Sources/LocalMediaURL.swift',join(root,'main.swift'),'-o',join(root,'cases')],{stdio:'pipe'})
  assert.match(execFileSync(join(root,'cases'),{encoding:'utf8'}),/validated/)
 }finally{await rm(root,{recursive:true,force:true})}
})
