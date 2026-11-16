import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const output=await build({stdin:{contents:"export {videoDetailFromTrack,seasonVideoRow} from './src/domain/videoMetadata';export {toTrack} from './src/services/collectionTrack'",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'})
const {videoDetailFromTrack,seasonVideoRow,toTrack}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
test('metadata round trip preserves zero plays, publication, chapter context and part artwork',()=>{
 const parts=[{cid:1,page:1,title:'第一章',durationSeconds:30,coverUrl:'part-cover'},{cid:2,page:2,title:'第二章',durationSeconds:40}]
 const video={bvid:'BV123',aid:42,cid:1,title:'视频',coverUrl:'video-cover',publishedAt:123456,playCount:0,parts}
 const row=seasonVideoRow(video,{uploaderId:1,uploaderName:'作者'})
 const detail=videoDetailFromTrack(row,parts),track=toTrack(detail,parts[0])
 assert.equal(detail.playCount,0);assert.equal(track.playCount,0);assert.equal(track.publishedAt,123456)
 assert.equal(track.title,'第一章');assert.equal(track.chapterContext,true);assert.equal(detail.parts[0].coverUrl,'part-cover')
 assert.equal(videoDetailFromTrack(track,parts).playCount,0)
})
