import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const output = await build({ entryPoints: ['src/shared/artworkThumbnail.ts'], bundle: true, write: false, format: 'esm' })
const { artworkThumbnail } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

test('list and player can use one smaller URL for each supported cover CDN', () => {
  assert.equal(artworkThumbnail('//i1.hdslb.com/bfs/archive/example.jpg'), 'https://i1.hdslb.com/bfs/archive/example.jpg@160w.jpg')
  assert.equal(artworkThumbnail('http://p2.music.126.net/image==/123.jpg'), 'https://p2.music.126.net/image==/123.jpg?param=160y160')
  assert.equal(artworkThumbnail('https://y.gtimg.cn/music/photo_new/T002R500x500M00000album.jpg'), 'https://y.gtimg.cn/music/photo_new/T002R150x150M00000album.jpg')
})

test('custom, resized and signed artwork keeps its original URL', () => {
  for (const cover of [
    undefined,
    '/local/cover.png',
    'https://example.test/cover.jpg',
    'https://i1.hdslb.com.example.test/bfs/archive/example.jpg',
    'https://i1.hdslb.com/bfs/archive/example.jpg@160w.jpg',
    'https://p2.music.126.net/image==/123.jpg?token=value',
    'https://y.gtimg.cn/music/photo_new/T002R90x90M00000album.jpg',
  ]) assert.equal(artworkThumbnail(cover), undefined)
})
