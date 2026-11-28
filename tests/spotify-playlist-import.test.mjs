import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['src/services/spotifyPlaylistImport.ts'],
  bundle: true,
  write: false,
  format: 'esm',
})
const { parseSpotifyPlaylistFile, readSpotifyPlaylistFile } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)

const track = id => `spotify:track:${String(id).padStart(22, '0')}`

test('Spotify account JSON keeps playlist order and only imports music rows', () => {
  const item = { track: { trackName: '初恋', artistName: '某位歌手', albumName: '某张专辑', trackUri: track(1) } }
  const text = JSON.stringify({ playlists: [
    { name: '我的歌单', items: [
      item,
      { track: null, episode: { episodeName: '播客' } },
      { track: null, audiobook: { name: '有声书' } },
      { track: null, localTrack: { uri: 'spotify:local:a:b:c:45' } },
      { track: null },
      item,
      { track: { trackName: '第二首', artistName: 'Artist with, comma' } },
    ] },
    { name: '空歌单', items: [] },
  ] })
  const lists = parseSpotifyPlaylistFile(`\uFEFF${text}`, 'Playlist1.json')
  assert.deepEqual(lists.map(({ name }) => name), ['我的歌单', '空歌单'])
  assert.deepEqual(lists[0], {
    name: '我的歌单',
    source: 'spotify',
    songs: [
      { sourceId: track(1), title: '初恋', artists: ['某位歌手'], album: '某张专辑' },
      { sourceId: 'spotify:row:6', title: '第二首', artists: ['Artist with, comma'] },
    ],
    reportedCount: 7,
    unavailableCount: 4,
  })
  assert.equal(lists[1].songs.length, 0)
})

test('Exportify CSV reads UTF-8 BOM, quoting, escaped artist commas, albums and milliseconds', () => {
  const csv = [
    '"Track URI","Track Name","Artist Name(s)","Album Name","Track Duration (ms)","Album Image URL"',
    `"${track(3)}","Song ""One"", plus\nsecond line","Tyler\\, The Creator, Guest","The album","290510","https://unused.test/album.jpg"`,
    `"${track(4)}","Song Two","Someone, Another","Album Two","120010",""`,
    '"spotify:local:Artist:Album:Song:22","Local Song","Artist","Album","22000",""',
    `"${track(3)}","Song One","Tyler\\, The Creator","The album","290510",""`,
    '"spotify:episode:0000000000000000000005","Podcast","Host","","400000",""',
  ].join('\r\n')
  const [list] = parseSpotifyPlaylistFile(`\uFEFF${csv}\r\n`, 'My Playlist.csv')
  assert.equal(list.name, 'My Playlist')
  assert.equal(list.reportedCount, 5)
  assert.equal(list.unavailableCount, 2)
  assert.deepEqual(list.songs, [
    { sourceId: track(3), title: 'Song "One", plus\nsecond line', artists: ['Tyler, The Creator', 'Guest'], album: 'The album', durationSeconds: 290.51 },
    { sourceId: track(4), title: 'Song Two', artists: ['Someone', 'Another'], album: 'Album Two', durationSeconds: 120.01 },
  ])
})

test('legacy Exportify duration and semicolon artist separator are supported', () => {
  const csv = `Track URI,ISRC,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms)\n${track(1)},,Song,Album,"Tyler, The Creator;Guest",2026,19000`
  const [list] = parseSpotifyPlaylistFile(csv, '旧歌单.csv')
  assert.deepEqual(list.songs[0].artists, ['Tyler, The Creator', 'Guest'])
  assert.equal(list.songs[0].durationSeconds, 19)
})

test('localized Exportify headers preserve artists, albums and duration', () => {
  for (const header of [
    '曲目 URI,曲目名称,艺人名称,专辑名称,曲目时长（毫秒）',
    '曲目 URI,曲目名稱,藝人名稱,專輯名稱,曲目長度（毫秒）',
    'トラックURI,トラック名,アーティスト名,アルバム名,トラックの長さ（ミリ秒）',
  ]) {
    const [list] = parseSpotifyPlaylistFile(`${header}\n${track(1)},歌曲,艺人,专辑,58130`, '导出.csv')
    assert.deepEqual(list.songs[0], {
      sourceId: track(1), title: '歌曲', artists: ['艺人'], album: '专辑', durationSeconds: 58.13,
    })
  }
})

test('a large Spotify list preserves its count without affecting other playlists', () => {
  const large = Array.from({ length: 5001 }, (_, index) => ({
    track: { trackName: `Song ${index}`, artistName: 'Artist', trackUri: track(index + 1) },
  }))
  const lists = parseSpotifyPlaylistFile(JSON.stringify({ playlists: [
    { name: '长歌单', items: large },
    { name: '短歌单', items: large.slice(0, 2) },
  ] }), 'Playlist.json')
  assert.equal(lists[0].songs.length, 5001)
  assert.equal(lists[0].reportedCount, 5001)
  assert.equal(lists[1].songs.length, 2)
})

test('wrong accounts files, empty inputs and malformed CSV are reported', () => {
  assert.throws(() => parseSpotifyPlaylistFile('{"username":"someone"}', 'Userdata.json'), /账号资料中的 Playlist/)
  assert.throws(() => parseSpotifyPlaylistFile('Track Name,Abc\nSong,2', 'unrelated.csv'), /Exportify/)
  assert.throws(() => parseSpotifyPlaylistFile('Track URI,Track Name,Artist Name(s)\n"unfinished', 'broken.csv'), /不完整/)
  assert.throws(() => parseSpotifyPlaylistFile('   ', 'empty.json'), /为空/)
})

test('file reader uses UTF-8 and rejects oversized files before reading', async t => {
  const before = globalThis.FileReader
  t.after(() => { globalThis.FileReader = before })
  globalThis.FileReader = class {
    readAsText(file, encoding) {
      assert.equal(encoding, 'UTF-8')
      this.result = file.contents
      this.onload()
    }
  }
  const contents = `Track URI,Track Name,Artist Name(s)\n${track(1)},路径,歌手`
  const [list] = await readSpotifyPlaylistFile({ size: Buffer.byteLength(contents), name: '测试.csv', contents })
  assert.equal(list.songs[0].title, '路径')
  await assert.rejects(readSpotifyPlaylistFile({ size: 17 * 1024 ** 2, name: 'oversized.csv' }), /16 MB/)
})
