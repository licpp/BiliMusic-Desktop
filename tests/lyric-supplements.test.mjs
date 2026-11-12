import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const output=await build({entryPoints:['src/features/lyrics/lrc.ts'],bundle:true,write:false,format:'esm',platform:'node'})
const {candidateLines,lyricSupplementModes,nextLyricSupplement}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
const candidate={provider:'netease',id:1,trackName:'test',artistName:'artist',duration:10,syncedLyrics:'[00:00.00]credits\n[00:01.00]first\n[00:04.00]second\n[00:08.00]third',translatedLyrics:'[00:01.01]第一句\n[00:08.00]第三句',romanizedLyrics:'[00:01.00]a b\n[00:04.00]c d\n[00:08.00]e f'}
test('翻译按时间对齐，缺行不会移位，音译独立对齐并随保存恢复',()=>{
  const lines=candidateLines(candidate)
  assert.equal(lines[0].translation,undefined)
  assert.equal(lines[1].translation,'第一句')
  assert.equal(lines[2].translation,undefined)
  assert.equal(lines[3].translation,'第三句')
  assert.equal(lines[2].romanization,'c d')
  assert.deepEqual(JSON.parse(JSON.stringify(lines)),lines)
})
test('循环关闭、音译、翻译，缺少的选项自动跳过，不生成假音译',()=>{
  const both=lyricSupplementModes(candidateLines(candidate))
  assert.deepEqual(both,['off','romanization','translation'])
  assert.equal(nextLyricSupplement('off',both),'romanization')
  assert.equal(nextLyricSupplement('romanization',both),'translation')
  assert.equal(nextLyricSupplement('translation',both),'off')
  const translated=lyricSupplementModes(candidateLines({...candidate,romanizedLyrics:undefined}))
  assert.deepEqual(translated,['off','translation'])
  assert.equal(nextLyricSupplement('romanization',translated),'translation')
  assert.deepEqual(lyricSupplementModes(candidateLines({...candidate,translatedLyrics:undefined,romanizedLyrics:undefined})),['off'])
})
test('时间不对应、重复原文和空占位不显示为附加歌词',()=>{
  const lines=candidateLines({...candidate,translatedLyrics:'[00:02.00]wrong\n[00:04.00]second\n[00:08.00]//',romanizedLyrics:undefined})
  assert.ok(lines.every(line=>!line.translation&&!line.romanization))
})
