import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const compiled = await build({
  stdin: { contents: `export * from './src/domain/songIdentity'; export * from './src/services/desktopApi'; export * from './src/services/accountScope'; export * from './src/services/externalSongMatch'; export * from './src/services/musicMatchRanking'`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'ipc', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'core', namespace: 'mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `export const isTauri=()=>true; export const invoke=(command,args)=>globalThis.songIpc(command,args); export class Channel {}` }))
  } }],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const api = module.exports
const lyric = (trackName='红豆', artistName='王菲', provider='netease', id=1) => ({ trackName, artistName, provider, id, syncedLyrics:'[00:01]红豆', duration:240 })
const catalog = (trackName='红豆', artistName='王菲', source='网易云', trackId='1') => ({ trackName, artistName, source, trackId, artworkUrl:'https://example.com/cover.jpg' })

test('playlist, lyric and catalog matching share noisy title / entity recognition', async () => {
  for (const [title,uploader,song,singer] of [
    ['在百万豪装录音棚听王菲《红豆》','JLRS-LeoFM','红豆','王菲'],
    ['【私藏馆】孙燕姿 《遇见》 爆火神曲！祝大家节日快乐','音乐私藏馆','遇见','孙燕姿'],
    ['【4K60FPS】Adele &quot;Someone Like You&quot;','频道','Someone Like You','Adele'],
  ]) {
    const calls=[]
    globalThis.songIpc=async (command,args)=>{
      calls.push({command,...args})
      return command==='lyrics_search'?{candidates:[lyric('其他歌曲','其他歌手','qq',2),lyric(song,singer)]}:[catalog('其他歌曲','其他歌手','QQ','2'),catalog(song,singer)]
    }
    const lyrics=await api.searchLyrics(title,undefined,true)
    const metadata=await api.searchMetadataCatalog(title,uploader,'auto',{uploaderName:uploader})
    assert.equal(lyrics.candidates[0].trackName,song)
    assert.equal(metadata[0].trackName,song)
    assert.equal(calls.length,2)
    for (const call of calls) assert.deepEqual({title:call.title,artist:call.artist},{title:song,artist:singer})
    assert.equal(calls[0].forceRefresh,true)
    assert.equal(calls[1].source,'auto')
    const result=api.rankSongCandidates({title:song,artists:[singer],durationSeconds:240},[{bvid:'BV1',cid:1,title,durationSeconds:240,partCount:1,detailsVerified:true,uploaderName:uploader}])
    assert.equal(result.decision,'automatic')
  }
})

test('shared edition identity retains every edition and never uses bilingual aliases as artists',()=>{
  for (const [input,expected] of [
    ['王菲《红豆 (Live)》翻唱','红豆 (Live) (Cover)'],
    ['王菲《红豆》粤语不插电版','红豆 (Acoustic) (粤语)'],
    ['王菲《红豆》Inst. Orch.','红豆 (Instrumental) (Orchestral)'],
  ]) assert.equal(api.firstSongQuery({title:input}).title,expected)
  assert.equal(api.songTitleIdentity('红豆（现场版）'),api.songTitleIdentity('红豆 (Live)'))
  assert.notEqual(api.songTitleIdentity('红豆'),api.songTitleIdentity('红豆 (Live)'))
  assert.deepEqual(api.firstSongQuery({title:'日日 (Days)',artist:'陈粒'}),{title:'日日',artist:'陈粒'})
  assert.equal(api.firstSongQuery({title:'Hello (feat. Adele)'}).title,'Hello')
  assert.equal(api.firstSongQuery({title:'1979'}).title,'1979')
  assert.equal(api.containsSongTitle('Starlight','Star'),false)
  assert.equal(api.firstSongQuery({title:'王菲《红豆》《流年》连唱'}).title,'王菲《红豆》《流年》连唱')
})

test('manual result ranking uses extracted identity but retains duration / source preferences',()=>{
  const title='在百万豪装录音棚听王菲《红豆》'
  assert.equal(api.rankLyricCandidates([lyric('红豆','其他歌手','qq',2),lyric()],title)[0].id,1)
  assert.equal(api.rankCatalogCandidates([catalog('红豆','其他歌手','QQ','2'),catalog()],title)[0].trackId,'1')
  const original=lyric(),live=lyric('红豆 (Live)','王菲','qq',2)
  assert.equal(api.rankLyricCandidates([original,live],'红豆（现场版）','王菲')[0].id,2)
  const request={title:'红豆',artists:['王菲'],durationSeconds:240}
  assert.equal(api.rankSongCandidates(request,[{bvid:'BV1',cid:1,title:'王菲《红豆》（现场版）',detailsVerified:true,partCount:1,durationSeconds:240}]).decision,'review')
})

test('ambiguous lookups are bounded, deduplicated by provider and keep partial-source warnings', async()=>{
  const calls=[]
  globalThis.songIpc=async (command,args)=>{
    calls.push(args)
    return command==='lyrics_search'?{candidates:[lyric(),lyric('红豆','王菲','qq')],warning:'QQ 暂不可用'}:[catalog(),catalog('红豆','王菲','QQ')]
  }
  const found=await api.searchLyrics('王菲 - 红豆')
  assert.equal(calls.length,2)
  assert.deepEqual(calls.map(({title,artist})=>({title,artist})),[{title:'王菲',artist:'红豆'},{title:'红豆',artist:'王菲'}])
  assert.equal(found.candidates.length,2)
  assert.equal(found.warning,'QQ 暂不可用')
  calls.length=0
  assert.equal((await api.searchMetadataCatalog('王菲 - 红豆','','qq')).length,2)
  assert.equal(calls.length,2)
  assert(calls.every(call=>call.source==='qq'))
})

test('query failures keep successful results; all failures keep the original error',async()=>{
  let count=0
  const error={code:'NETWORK',message:'source failed'}
  globalThis.songIpc=async()=>{if (++count===1)throw error;return{candidates:[lyric()]}}
  const result=await api.searchLyrics('王菲 - 红豆')
  assert.equal(result.candidates.length,1)
  assert.match(result.warning,/部分查询/)
  globalThis.songIpc=async()=>{throw error}
  await assert.rejects(api.searchLyrics('王菲 - 红豆'),caught=>caught===error)
  let calls=0
  globalThis.songIpc=async()=>{calls++;return{candidates:[]}}
  assert.deepEqual((await api.searchLyrics('  ')).candidates,[])
  assert.equal(calls,0)
})

test('account changes discard late results and never launch another orientation',async()=>{
  globalThis.window = new EventTarget()
  for (const kind of ['lyrics','catalog']) for (const reject of [false,true]) {
    let finish,calls=0
    globalThis.songIpc=()=>{calls++;return new Promise((resolve,fail)=>{finish=()=>reject?fail(new Error('network')):resolve(kind==='lyrics'?{candidates:[lyric()]}:[catalog()])})}
    const pending=kind==='lyrics'?api.searchLyrics('王菲 - 红豆'):api.searchMetadataCatalog('王菲 - 红豆','')
    api.advanceAccountEpoch();api.advanceAccountEpoch() // A -> B -> A is still a new session.
    finish()
    await assert.rejects(pending,/ACCOUNT_SESSION_EXPIRED/)
    assert.equal(calls,1)
  }
})
