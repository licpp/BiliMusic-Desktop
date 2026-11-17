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
// A competing player never creates intent if this app was already paused.
resume.begin(wasPlaying:false);precondition(!resume.finish(allowed:true))
// Explicit pause/stop cancels a delayed recommendation, including duplicates.
resume.begin(wasPlaying:true);resume.cancel();precondition(!resume.finish(allowed:true));precondition(!resume.finish(allowed:true))
// A legacy media app may omit the end event. Returning to BiliMusic recovers
// only the captured interruption, after other audio has stopped.
resume.begin(wasPlaying:true)
let missingEnd = resume.foregroundToken!
precondition(!resume.canRecoverInForeground(token:missingEnd,otherAudioPlaying:true))
precondition(resume.canRecoverInForeground(token:missingEnd,otherAudioPlaying:false))
// A failed activation does not consume intent; the next foreground can retry.
precondition(resume.foregroundToken == missingEnd)
precondition(resume.finish(allowed:true));precondition(resume.foregroundToken == nil)
precondition(!resume.canRecoverInForeground(token:missingEnd,otherAudioPlaying:false))
resume.begin(wasPlaying:true);let manual = resume.foregroundToken!;resume.cancel()
precondition(!resume.canRecoverInForeground(token:manual,otherAudioPlaying:false))
resume.begin(wasPlaying:true);let denied = resume.foregroundToken!;precondition(!resume.finish(allowed:false))
precondition(!resume.canRecoverInForeground(token:denied,otherAudioPlaying:false))
resume.begin(wasPlaying:true);let stale = resume.foregroundToken!;resume.begin(wasPlaying:false)
precondition(!resume.canRecoverInForeground(token:stale,otherAudioPlaying:false))
precondition(resume.canRecoverInForeground(token:resume.foregroundToken!,otherAudioPlaying:false))
resume.cancel();resume.begin(wasPlaying:false);precondition(resume.foregroundToken == nil)
var recovery = PlaybackRecovery()
let threshold = AutomaticResumePolicy(enabled:true,thresholdSeconds:600,collection:false,durationSeconds:0)
recovery.prepare(policy:threshold)
precondition(recovery.automaticResume?.thresholdSeconds == 600)
precondition(recovery.position(current:0,saved:85,requested:85,initialPending:true)==85)
recovery.chosePosition();precondition(recovery.automaticResume == nil)
recovery.completedSeek(false)
precondition(recovery.position(current:12,saved:85,requested:0,initialPending:false)==85)
// A cancelled backward seek restores the intended smaller position too.
precondition(recovery.position(current:120,saved:20,requested:0,initialPending:false)==20)
recovery.completedSeek(true)
precondition(recovery.position(current:23,saved:20,requested:0,initialPending:false)==23)
recovery.prepare(policy:nil);precondition(!recovery.seekFailed)
precondition(recovery.position(current:.nan,saved:32,requested:.nan,initialPending:false)==32)
print("interruption cases passed")
`)
  const dev='/Applications/Xcode.app/Contents/Developer'
  const sdk=execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8',env:{...process.env,DEVELOPER_DIR:dev}}).trim()
  execFileSync(`${dev}/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc`,['-sdk',sdk,'-module-cache-path',join(folder,'module-cache'),'native/ios-player/ios/Sources/InterruptionResume.swift','native/ios-player/ios/Sources/ResumePolicy.swift','native/ios-player/ios/Sources/PlaybackRecovery.swift',join(folder,'main.swift'),'-o',join(folder,'cases')],{cwd:resolve('.'),timeout:60000})
  assert.match(execFileSync(join(folder,'cases'),{encoding:'utf8'}),/cases passed/)
 }finally{await rm(folder,{recursive:true,force:true})}
})
