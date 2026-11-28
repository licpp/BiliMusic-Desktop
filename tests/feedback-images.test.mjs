import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'

const built = await build({entryPoints: ['src/services/feedbackImages.ts'], bundle: true, write: false, format: 'esm'})
const {
  FEEDBACK_IMAGE_MAX_BYTES,
  FEEDBACK_IMAGE_MAX_COUNT,
  feedbackClipboardImages,
  feedbackImagePreview,
  readFeedbackImages,
} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const jpeg = [0xff, 0xd8, 0xff]
const webp = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]
const file = (name, signature, overrides = {}) => ({name, size: signature.length, signature, ...overrides})

function fakeFileReader(t) {
  const read = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'FileReader')
  class FileReader {
    readAsArrayBuffer(file) {
      read.push(file.name)
      queueMicrotask(() => {
        if (file.error) {
          this.onerror()
        } else {
          this.result = Uint8Array.from(file.signature).buffer
          this.onload()
        }
      })
    }
  }
  Object.defineProperty(globalThis, 'FileReader', {configurable: true, value: FileReader})
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'FileReader', previous)
    else delete globalThis.FileReader
  })
  return read
}

test('picks clipboard images without creating a second copy from clipboard items', () => {
  const screenshot = file('剪贴板.png', png, {type: 'image/png'})
  const photo = file('照片.jpg', jpeg, {type: ''})
  assert.deepEqual(feedbackClipboardImages({
    files: [screenshot, photo, file('说明.txt', [], {type: 'text/plain'})],
    items: [{kind: 'file', type: 'image/png', getAsFile: () => screenshot}],
  }), [screenshot, photo])
})

test('accepts image clipboard items and leaves plain text to normal paste', () => {
  const screenshot = file('image.png', png, {type: 'image/png'})
  const text = {kind: 'string', type: 'text/plain'}
  assert.deepEqual(feedbackClipboardImages(null), [])
  assert.deepEqual(feedbackClipboardImages({files: [], items: [text]}), [])
  assert.deepEqual(feedbackClipboardImages({files: [], items: [text,
    {kind: 'file', type: 'image/png', getAsFile: () => null},
    {kind: 'file', type: 'image/png', getAsFile: () => screenshot},
  ]}), [screenshot])
})

test('reads each supported image type from bytes and produces matching preview URLs', async t => {
  fakeFileReader(t)
  const result = await readFeedbackImages({
    0: file('设备截图.png', png),
    1: file('照片.jpeg', jpeg, {type: 'application/octet-stream'}),
    2: file('图片.dat', webp, {type: 'image/jpeg'}),
    length: 3,
  })
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.images.map(image => image.mimeType), ['image/png', 'image/jpeg', 'image/webp'])
  assert.equal(feedbackImagePreview(result.images[0]), `data:image/png;base64,${Buffer.from(png).toString('base64')}`)
  assert.equal(result.images[0].name, '设备截图.png')
})

test('rejects renamed non-images and HEIC from the picker', async t => {
  fakeFileReader(t)
  const result = await readFeedbackImages([
    file('假图片.png', [...Buffer.from('<svg>')], {type: 'image/png'}),
    file('照片.heic', [...Buffer.from('....ftypheic')], {type: 'image/heic'}),
  ])
  assert.deepEqual(result.images, [])
  assert.equal(result.errors.length, 2)
  assert.match(result.errors[0], /假图片\.png.*JPG、PNG 或 WebP/)
  assert.match(result.errors[1], /照片\.heic.*JPG、PNG 或 WebP/)
})

test('rejects oversized images before reading and counts remaining attachment slots', async t => {
  const read = fakeFileReader(t)
  const result = await readFeedbackImages([
    file('过大.png', png, {size: FEEDBACK_IMAGE_MAX_BYTES + 1}),
    file('剩余位置.png', png),
    file('超过上限.png', png),
  ], FEEDBACK_IMAGE_MAX_COUNT - 1)
  assert.deepEqual(read, ['剩余位置.png'])
  assert.deepEqual(result.images.map(image => image.name), ['剩余位置.png'])
  assert.match(result.errors[0], /超过 2 MB/)
  assert.match(result.errors[1], /最多添加 3 张/)
})

test('reports failed and incomplete reads without preventing valid attachments', async t => {
  fakeFileReader(t)
  const result = await readFeedbackImages([
    file('读取失败.png', png, {error: true}),
    file('读取不完整.png', png, {size: png.length + 10}),
    file('有效.png', png),
  ])
  assert.deepEqual(result.images.map(image => image.name), ['有效.png'])
  assert.equal(result.errors.length, 2)
  assert.match(result.errors[0], /无法读取 读取失败\.png/)
  assert.match(result.errors[1], /无法读取 读取不完整\.png/)
})

test('encodes a file at the size limit without exceeding the engine argument limit', async t => {
  fakeFileReader(t)
  const bytes = Buffer.alloc(FEEDBACK_IMAGE_MAX_BYTES, 0xa4)
  bytes.set(png)
  const result = await readFeedbackImages([file('最大尺寸.png', bytes)])
  assert.deepEqual(result.errors, [])
  assert.equal(result.images[0].base64, bytes.toString('base64'))
})
