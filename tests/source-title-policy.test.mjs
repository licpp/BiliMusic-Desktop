import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const text=(await build({entryPoints:['src/domain/sourceTitle.ts'],bundle:true,write:false,format:'esm'})).outputFiles[0].text
const {sourceTitle}=await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)
test('single-P videos keep the BV title after lazy catalog resolution and queue restore', async () => {
 const {readFile}=await import('node:fs/promises')
 const fixture=JSON.parse(await readFile('tests/fixtures/single-part-catalog.json','utf8'))
 const {bvid,aid,cid,videoTitle,partTitle,catalogs}=fixture
 const {outputFiles}=await build({
  stdin:{contents:"export {creatorVideoRow,favoriteVideoTrack,videoDetailFromTrack,seasonVideoRow} from './src/services/mediaSources';export {toTrack} from './src/services/collectionTrack';export {withTrackTitle} from './src/domain/sourceTitle'",resolveDir:process.cwd()},
  bundle:true,write:false,format:'esm',
 })
 const {creatorVideoRow,favoriteVideoTrack,videoDetailFromTrack,seasonVideoRow,toTrack,withTrackTitle}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
 const video={bvid,aid,cid:0,title:videoTitle,pic:'',cover:'',coverUrl:'',duration:240,durationSeconds:240}
 const part={cid,page:1,title:partTitle,durationSeconds:240}
 const verify = row => {
  const detail=videoDetailFromTrack(row,[part])
  const track=toTrack(detail,part)
  assert.equal(track.id,`bilibili:${bvid}:${cid}`)
  assert.equal(track.title,videoTitle)
  assert.equal(track.sourceTitleContext.season,undefined)
  assert.equal(toTrack(videoDetailFromTrack(row,[part,{...part,cid:cid+1,page:2}]),part).title,partTitle)
 }
 const creator=creatorVideoRow(video,catalogs[0].uploaderId,catalogs[0].uploaderName)
 assert.equal(creator.source.uploaderId,catalogs[0].uploaderId)
 verify(creator)
 verify(favoriteVideoTrack(video))
 for (const season of catalogs) {
  const old={...creator,chapterContext:true,sourceTitleContext:{videoTitle,partTitle,partCount:1,chapterContext:true,season}}
  verify(old)
  assert.equal(withTrackTitle({...old,title:partTitle}).title,videoTitle)
  assert.equal(withTrackTitle({...old,title:'我的歌名',titleOverridden:true}).title,'我的歌名')
 }
 const actualSeason={...catalogs[0],id:54812,title:'忘川风华录主题曲合集'}
 assert.equal(toTrack(videoDetailFromTrack(seasonVideoRow(video,actualSeason),[part]),part).title,partTitle)
})
test('chapter titles are consistent for single-P season members and multi-P videos',()=>{
 assert.equal(sourceTitle('长 BV 标题','四、周旋权臣',1,true),'四、周旋权臣')
 assert.equal(sourceTitle('普通视频','不同的P1名称',1,false),'普通视频')
 for(const title of ['','   ','P1','part 1','正片','视频','默认标题'])assert.equal(sourceTitle('BV 标题',title,1,true),'BV 标题')
 assert.equal(sourceTitle('BV 标题','第二章',2,false),'第二章')
})
test('shared track conversion uses season membership without changing BV/CID identity',async()=>{
 const code=(await build({entryPoints:['src/services/collectionTrack.ts'],bundle:true,write:false,format:'esm'})).outputFiles[0].text
 const {toTrack}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
 const part={cid:38410979580,page:1,title:'四、周旋权臣',durationSeconds:100}
 const detail={bvid:'BV1GFRFBREe6',title:'AI喻大华 守成天子嘉庆 未删减版 04周旋权臣',parts:[part],season:{id:1}}
 const track=toTrack(detail,part)
 assert.equal(track.displayTitle,'四、周旋权臣');assert.equal(track.title,'四、周旋权臣')
 assert.equal(track.id,'bilibili:BV1GFRFBREe6:38410979580');assert.equal(track.chapterContext,true)
 assert.equal(toTrack({...detail,season:undefined},part).title,detail.title)
})

test('shared Rust and TypeScript source title fixtures agree', async () => {
 const {readFile}=await import('node:fs/promises')
 const cases=JSON.parse(await readFile('tests/fixtures/source-title.json','utf8'))
 for(const c of cases) assert.equal(sourceTitle(c.video,c.part,c.count,c.chapter,c.series),c.expected)
})

test('series prefix removal is contextual and user titles win over all source caches',async()=>{
 const code=(await build({entryPoints:['src/domain/sourceTitle.ts'],bundle:true,write:false,format:'esm'})).outputFiles[0].text
 const {withTrackTitle,contentTitle}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
 const context={videoTitle:'AI喻大华 苦命皇帝咸丰 未删减版 01谁是太子',partTitle:'01谁是太子',partCount:1,season:{id:10,uploaderId:42,title:'AI喻大华 苦命皇帝咸丰 未删减版'}}
 const old={id:'bilibili:BV123:1',title:context.videoTitle,displayTitle:context.videoTitle,sourceTitleContext:context}
 assert.equal(withTrackTitle(old).title,'01谁是太子')
 assert.equal(withTrackTitle(JSON.parse(JSON.stringify(withTrackTitle(old)))).title,'01谁是太子')
 assert.equal(withTrackTitle({...old,title:'我的标题',titleOverridden:true}).displayTitle,'我的标题')
 assert.equal(contentTitle({videoTitle:'在百万豪装录音棚听王菲《红豆》',partTitle:'P1',partCount:1}),'红豆')
 assert.equal(contentTitle({videoTitle:'纪录片《红豆》',partTitle:'P1',partCount:1}),'纪录片《红豆》')
 assert.equal(contentTitle({videoTitle:'在百万豪装录音棚听《红豆》《流年》',partTitle:'P1',partCount:1}),'在百万豪装录音棚听《红豆》《流年》')
})

test('series information is shown in mixed lists and omitted beneath the same series heading',async()=>{
 const code=(await build({entryPoints:['src/domain/sourceTitle.ts'],bundle:true,write:false,format:'esm'})).outputFiles[0].text
 const {trackSubtitle}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
 const track={artist:'',source:{uploaderName:'远哥挺乐'},sourceTitleContext:{season:{id:10,uploaderId:42,title:'苦命皇帝咸丰'}}}
 assert.equal(trackSubtitle(track),'苦命皇帝咸丰')
 assert.equal(trackSubtitle(track,{kind:'season',title:'苦命皇帝咸丰'}),'')
 assert.equal(trackSubtitle(track,{collectionRef:'season:42:10'}),'')
 assert.equal(trackSubtitle(track,{kind:'season',title:'其他合集'}),'苦命皇帝咸丰')
})

test('known singer takes precedence over series; explicit singers may also be the uploader',async()=>{
 const {trackSubtitle,knownArtist}=await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)
 const track={id:'song:1',artist:'王菲',source:{uploaderName:'音乐频道'},sourceTitleContext:{season:{id:10,uploaderId:42,title:'王菲作品合集'}}}
 assert.equal(trackSubtitle(track),'王菲')
 assert.equal(trackSubtitle(track,{collectionRef:'season:42:10'}),'王菲')
 for(const artist of ['', '歌手未知','未知歌手','unknown artist'])assert.equal(trackSubtitle({...track,artist}),'王菲作品合集')
 const sameUploader={...track,source:{uploaderName:'王菲'}}
 assert.equal(knownArtist(sameUploader),'')
 assert.equal(trackSubtitle({...sameUploader,titleOverridden:true}),'王菲')
 assert.equal(trackSubtitle({...sameUploader,importedEntry:{trackId:'song:1'}}),'王菲')
 assert.equal(knownArtist({...sameUploader,importedEntry:{trackId:'other'}}),'')
})
