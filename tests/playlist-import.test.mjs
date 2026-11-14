import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const {outputFiles}=await build({entryPoints:['src/services/playlistImportModel.ts'],bundle:true,write:false,format:'esm'})
const {parseSongList,chooseImportMatch,importKeyword}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const song={sourceId:'external:1',title:'晴天',artists:['周杰伦'],durationSeconds:269}
const choice=(cid,title='周杰伦《晴天》',durationSeconds=269,extra={})=>({track:{id:`bilibili:BV1GJ411x7h7:${cid}`,source:{provider:'bilibili',bvid:'BV1GJ411x7h7',cid,page:cid},title,durationSeconds,liked:false},evidence:{bvid:'BV1GJ411x7h7',cid,title,durationSeconds,partCount:1,detailsVerified:true,...extra}})
test('文本导入能保留英文数字曲名、多歌手、时长和原顺序，并去掉分享文字及重复项',()=>{
  const result=parseSongList('共 4 首\n1. 因为爱情 - 陈奕迅 / 王菲 04:12\n7 Rings - Ariana Grande\n01 晴天 - 周杰伦\n晴天 - 周杰伦\n分享链接 https://music.163.com/playlist?id=123')
  assert.deepEqual(result.songs.map(s=>s.title),['因为爱情','7 Rings','晴天'])
  assert.deepEqual(result.songs[0].artists,['陈奕迅','王菲'])
  assert.equal(result.songs[0].durationSeconds,252)
  assert.throws(()=>parseSongList('https://music.163.com/playlist?id=123'))
})
test('大歌单无需确认同版本的多个上传，直接给出合理默认值',()=>{
  assert.equal(chooseImportMatch(song,[choice(1),choice(2,undefined,270)]).track.source.cid,1)
})
test('导入默认跳过明显翻唱或错误时长，不用错误结果凑数',()=>{
  assert.equal(chooseImportMatch(song,[choice(1,'周杰伦《晴天》翻唱')]),undefined)
  assert.equal(chooseImportMatch(song,[choice(1,undefined,140)]),undefined)
})
test('来源信息只有曲名歌手的文本也能导入，但短同名歌曲不能混用歌手',()=>{
  assert.ok(chooseImportMatch({...song,durationSeconds:undefined},[choice(1)]))
  assert.equal(chooseImportMatch(song,[choice(1,'李荣浩《晴天》')]),undefined)
})
test('只导入详情确认过的 CID，未知分P不默认变成P1',()=>{
  assert.equal(chooseImportMatch(song,[choice(1,undefined,269,{cid:undefined,detailsVerified:false})]),undefined)
  assert.equal(chooseImportMatch(song,[choice(1,'七里香',269,{partCount:30,videoTitle:'周杰伦：晴天 / 七里香'})]),undefined)
})
test('有明确演唱会年份时避免把另一个年份的Live作为默认结果',()=>{
  const live={...song,title:'晴天 (Live)',album:'演唱会 2007'}
  assert.equal(chooseImportMatch(live,[choice(1,'周杰伦《晴天》Live 2011')]),undefined)
  assert.ok(chooseImportMatch(live,[choice(2,'周杰伦《晴天》Live',269,{partTitle:'晴天 2007'})]))
})
test('采样说明、双语括号不把搜索词无限加长，Live仍保留',()=>{
  assert.equal(importKeyword({...song,title:'Hong Kong (feat. 王菲季候风)',artists:['The Weeknd']}),'Hong Kong The Weeknd')
  assert.equal(importKeyword({...song,title:'日日 (Days)',artists:['陈粒']}),'日日 陈粒')
  assert.match(importKeyword({...song,title:'晴天 (Live)'}),/Live/)
  assert.equal(importKeyword({...song,title:'浮光 (Inst.)',artists:['纯音乐']}),'浮光 纯音乐')
  assert.equal(importKeyword({...song,title:'이젠 남 (现在是陌生人) (Now, we are strangers|Inst.)',artists:['Noblesse']}),'이젠 남 (现在是陌生人) Noblesse')
})
test('来源的电视剧说明不能当作曲名别名，把同剧其他歌曲匹配进来',()=>{
  assert.equal(chooseImportMatch({...song,aliases:['电视剧《某某》片头曲']},[choice(1,'周杰伦 电视剧《某某》片头曲 其他歌曲')]),undefined)
})
test('QQ original aliases never discard orchestral and instrumental version requirements',()=>{
 for(const suffix of ['Orch','Orchestral','管弦版','Inst.']) {
  const source={sourceId:'qq:1',title:`River Flows (${suffix})`,artists:['Artist'],durationSeconds:198,aliases:['River Flows']}
  assert.equal(chooseImportMatch(source,[choice(1,'Artist - River Flows',198)]),undefined,suffix)
  assert.ok(chooseImportMatch(source,[choice(1,`Artist - River Flows (${suffix})`,198)]),suffix)
 }
 assert.equal(chooseImportMatch({...song,title:'千秋 (Orch)',aliases:['千秋']},[choice(1,'周杰伦《千秋》')]),undefined)
 assert.equal(chooseImportMatch({...song,title:'River Flows',artists:['Artist']},[choice(1,'Artist - River Flows (Orch)')]),undefined)
})
