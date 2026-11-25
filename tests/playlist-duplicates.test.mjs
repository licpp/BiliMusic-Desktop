import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const {outputFiles}=await build({entryPoints:['src/domain/playlistDuplicates.ts'],bundle:true,write:false,format:'esm',platform:'node'})
const { duplicateAudioRank, findPlaylistDuplicates, preferredDuplicate } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const track=(id, title='晚风来信',extra={})=>({id,title,artist:'歌手',album:'沿海公路',durationSeconds:200,coverUrl:'same-album',source:{bvid:id},...extra})
test('duplicate review groups equal displayed title, artist and album regardless of source and duration',()=>{
 const tracks=[track('1'),track('2','原视频',{displayTitle:'晚风来信',coverUrl:'alternate'}),
   track('3','Late wind'),track('4','晚风来信',{artist:'另一位歌手'}),
   track('5','晚风来信',{videoTitle:'晚风来信现场版',durationSeconds:499}),
   track('6','晚风来信',{album:'现场专辑'}),track('7','晚风来信',{durationSeconds:0}),
   track('8','晚风来信',{album:''}),track('9','晚风来信',{album:undefined}),
   track('10','晚风来信',{artist:''}),track('11','晚风来信',{artist:undefined}),
   track('12','晚风来信（现场版）')]
 assert.deepEqual(findPlaylistDuplicates(tracks).map(group=>group.map(t=>t.id)),[['1','2','5','7']])
})
test('duplicate metadata uses imported credits unless superseded by user edits',()=>{
 const importedEntry = {song:{title:'  Late　Wind ', artists:['Singer'], album:'Album'}}
 const tracks = [
  track('1','late wind',{artist:'singer',album:'ALBUM'}),
  track('2','Source title',{importedEntry}),
  track('3','Different track',{titleOverridden:true,importedEntry}),
 ]
 assert.deepEqual(findPlaylistDuplicates(tracks).map(group=>group.map(t=>t.id)),[['1','2']])
})
test('automatic retention compares measured audio ranks and keeps playlist order on ties', () => {
 const tracks = [track('aac'), track('flac-a'), track('flac-b')]
 const scores = new Map([
  ['aac', duplicateAudioRank({ lossless: false, bitrate: 192000 })],
  ['flac-a', duplicateAudioRank({ lossless: true, bitrate: 960000 })],
  ['flac-b', duplicateAudioRank({ lossless: true, bitrate: 1100000 })],
 ])
 assert.equal(preferredDuplicate(tracks, candidate => scores.get(candidate.id))?.id, 'flac-a')
 assert.ok(duplicateAudioRank({ lossless: false, bitrate: 192000 }) > duplicateAudioRank({ lossless: false, bitrate: 128000 }))
 assert.equal(duplicateAudioRank({ lossless: false, bitrate: 0 }), undefined)
})
test('a real zero can rank, but a group with an unknown score needs review', () => {
 const tracks = [track('zero'), track('popular')]
 assert.equal(preferredDuplicate(tracks, candidate => candidate.id === 'zero' ? 0 : 100)?.id, 'popular')
 assert.equal(preferredDuplicate(tracks, () => 0)?.id, 'zero')
 assert.equal(preferredDuplicate(tracks, candidate => candidate.id === 'zero' ? 0 : undefined), undefined)
})
