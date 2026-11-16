import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
async function module(path){const r=await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'node'});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)}
const {songQueries,firstSongQuery}=await module('src/domain/songIdentity.ts')
test('编号标题兼容歌名在前和歌手在前，已填歌手优先，数字歌名保留',()=>{
 assert.deepEqual(firstSongQuery({title:'001. 晴天 - 周杰伦',artist:'周杰伦'}),{title:'晴天',artist:'周杰伦'})
 assert.deepEqual(firstSongQuery({title:'周杰伦 - 晴天',artist:'周杰伦'}),{title:'晴天',artist:'周杰伦'})
 assert.deepEqual(songQueries({title:'001. 晴天 - 周杰伦'}),[{title:'晴天',artist:'周杰伦'},{title:'周杰伦',artist:'晴天'}])
 assert.equal(firstSongQuery({title:'1979'}).title,'1979')
})

test('从栏目标题中提取歌名和歌手，不把上传者当成歌手', () => {
 for (const [title, artist, uploader, expected] of [
  ['在百万豪装录音棚听王菲《红豆》', '', 'JLRS-LeoFM', {title:'红豆',artist:'王菲'}],
  ['在百万豪装录音棚听王菲《红豆》', 'JLRS-LeoFM', 'JLRS-LeoFM', {title:'红豆',artist:'王菲'}],
  ['【私藏馆】孙燕姿 《遇见》 爆火神曲！祝大家节日快乐', '', '音乐私藏馆', {title:'遇见',artist:'孙燕姿'}],
  ['【私藏馆】孙燕姿 《遇见》 爆火神曲！祝大家节日快乐', '音乐私藏馆', '音乐私藏馆', {title:'遇见',artist:'孙燕姿'}],
  ['在百万豪装录音棚里听周杰伦《晴天》', '', '其他频道', {title:'晴天',artist:'周杰伦'}],
  ['【4K60FPS】戴上耳机听 Adele《Someone Like You》', '', '', {title:'Someone Like You',artist:'Adele'}],
  ['陈奕迅「十年」！经典重温', '', '', {title:'十年',artist:'陈奕迅'}],
  ['重温经典：王菲的《红豆》', '', '', {title:'红豆',artist:'王菲'}],
  ['周杰伦演唱的《晴天》', '', '', {title:'晴天',artist:'周杰伦'}],
  ['周杰伦“晴天”', '', '', {title:'晴天',artist:'周杰伦'}],
  ['《红豆》- 王菲', '', '', {title:'红豆',artist:'王菲'}],
  ['《红豆》真好听', '', '', {title:'红豆',artist:''}],
  ['王菲《红豆》', '窦靖童', '', {title:'红豆',artist:'窦靖童'}],
  ['听王菲《红豆》', '', '', {title:'红豆',artist:'王菲'}],
  ['原唱王菲《红豆》', '', '', {title:'红豆',artist:'王菲'}],
  ['王菲：红豆', '', '', {title:'红豆',artist:'王菲'}],
  ['红豆（王菲）', '', '', {title:'红豆',artist:'王菲'}],
 ]) assert.deepEqual(firstSongQuery({title,artist,source:{uploaderName:uploader}}), expected, title)
})

test('展示标签可清理，歌名、英文名称和版本信息不能误删', () => {
 for (const [title, song, artist] of [
  ['001.小幸运（无损）', '小幸运', ''],
  ['【音乐分享】王菲《红豆》（现场版）', '红豆 (Live)', '王菲'],
  ['王菲《红豆》 Remix', '红豆 (Remix)', '王菲'],
  ['王菲《红豆》伴奏', '红豆 (Instrumental)', '王菲'],
  ['王菲《红豆 (Live)》', '红豆 (Live)', '王菲'],
  ['红豆 (Live)', '红豆 (Live)', ''],
  ['Love Story', 'Love Story', ''],
  ['Yesterday (Remastered)', 'Yesterday (Remastered)', ''],
  ['The Beatles - Let It Be', 'The Beatles', 'Let It Be'],
  ['1979', '1979', ''],
  ['夜曲（钢琴版）', '夜曲(钢琴版)', ''],
  ['【遇见】', '【遇见】', ''],
 ]) assert.deepEqual(firstSongQuery({title}), {title:song,artist}, title)
 assert.equal(firstSongQuery({title:'《红豆》《遇见》双曲连播'}).title, '《红豆》《遇见》双曲连播')
 assert.equal(songQueries({title:'001.晴天 - 周杰伦'}).length, 2)
})

test('song names starting with 听 remain intact', () => {
 for(const title of ['听海','听妈妈的话','听说爱情回来过']) assert.equal(firstSongQuery({title}).title,title)
})
