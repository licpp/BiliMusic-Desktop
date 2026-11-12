import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const result=await build({entryPoints:['src/services/musicMatchRanking.ts'],bundle:true,write:false,platform:'node',format:'esm'})
const {rankLyricCandidates,rankCatalogCandidates}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const lyric=(provider,title='Lemon',artist='米津玄師',duration=255)=>({provider,id:1,trackName:title,artistName:artist,duration,syncedLyrics:'[00:00]a'})
test('同等命中时优先网易云和QQ，明显弱匹配不能压过精确结果',()=>{
  const items=[lyric('lrclib'),lyric('netease','Lemonade'),lyric('qq')]
  assert.deepEqual(rankLyricCandidates(items,'Lemon','米津玄師').map(x=>x.provider),['qq','lrclib','netease'])
  assert.equal(rankLyricCandidates([lyric('netease','Lemon','翻唱者'),lyric('lrclib')],'Lemon','米津玄師')[0].provider,'lrclib')
})
test('歌词时长接近优先于来源偏好',()=>{
  const items=[lyric('netease','Lemon','米津玄師',180),lyric('lrclib')]
  assert.equal(rankLyricCandidates(items,'Lemon','米津玄師',255)[0].provider,'lrclib')
})
test('封面同等匹配优先国内来源，不修改原始列表',()=>{
  const items=[{source:'iTunes',trackId:'1',trackName:'晴天',artistName:'周杰伦',artworkUrl:'https://example/1'}, {source:'QQ 音乐',trackId:'2',trackName:'晴天',artistName:'周杰伦',artworkUrl:'https://example/2'}, {source:'网易云音乐',trackId:'3',trackName:'晴天 现场翻唱',artistName:'其他歌手',artworkUrl:'https://example/3'}]
  assert.deepEqual(rankCatalogCandidates(items,'晴天','周杰伦').map(x=>x.trackId),['2','1','3'])
  assert.equal(items[0].trackId,'1')
})
