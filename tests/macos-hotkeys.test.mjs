import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

test('macOS native registered hotkeys report conflicts, deliver both edges and release system keys',{skip:process.platform!=='darwin'},async()=>{
 const folder=await mkdtemp(join(tmpdir(),'bilimusic-carbon-'))
 try {
  const binary=join(folder,'hotkey-probe')
  execFileSync('rustc',['--edition=2024','tests/native/macos-hotkey-probe.rs','-o',binary],{timeout:60000})
  assert.match(execFileSync(binary,{encoding:'utf8',timeout:15000}),/delivery and cleanup passed/)
 }finally{await rm(folder,{recursive:true,force:true})}
})
