import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'

test('iOS interruption intent survives repeated system pauses and is cancelled by explicit actions',{skip:process.platform!=='darwin'},async()=>{
 const folder=await mkdtemp(join(tmpdir(),'bilimusic-interruption-'))
 try {
  await writeFile(join(folder,'main.swift'),`
var resume = InterruptionResume()
precondition(!resume.finish(allowed:true))
resume.begin(wasPlaying:true);resume.begin(wasPlaying:false)
precondition(resume.finish(allowed:true));precondition(!resume.finish(allowed:true))
resume.begin(wasPlaying:false);precondition(!resume.finish(allowed:true))
resume.begin(wasPlaying:true);resume.cancel();precondition(!resume.finish(allowed:true))
resume.begin(wasPlaying:true);precondition(!resume.finish(allowed:false));precondition(!resume.finish(allowed:true))
print("interruption cases passed")
`)
  const dev='/Applications/Xcode.app/Contents/Developer'
  const sdk=execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8',env:{...process.env,DEVELOPER_DIR:dev}}).trim()
  execFileSync(`${dev}/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc`,['-sdk',sdk,'-module-cache-path',join(folder,'module-cache'),'native/ios-player/ios/Sources/InterruptionResume.swift',join(folder,'main.swift'),'-o',join(folder,'cases')],{cwd:resolve('.'),timeout:60000})
  assert.match(execFileSync(join(folder,'cases'),{encoding:'utf8'}),/cases passed/)
 }finally{await rm(folder,{recursive:true,force:true})}
})
