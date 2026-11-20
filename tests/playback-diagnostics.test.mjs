import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const output = await build({ entryPoints: ['src/features/player/playbackIssue.ts'], bundle: true, write: false, format: 'esm' })
const { playbackIssue, playbackDiagnosticText } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

test('playback diagnostics preserve native, upstream and account errors with the correct stage', () => {
  const decode = playbackIssue('audio-playback', '当前音源无法解码，请尝试更换音质', '', 'android_media:1:-2147483648')
  assert.equal(decode.code, 'android_media:1:-2147483648')
  assert.equal(decode.stage, 'audio-decode')
  const ios = playbackIssue('audio-playback', '音频加载失败', '', 'ios_media:NSURLErrorDomain:-1009')
  assert.equal(ios.code, 'ios_media:NSURLErrorDomain:-1009')
  assert.equal(ios.stage, 'audio-buffer')
  const harmony = playbackIssue('audio-playback', '音频加载失败', '', 'ohos_media:5400106')
  assert.equal(harmony.code, 'ohos_media:5400106')
  assert.equal(harmony.stage, 'audio-playback')
  assert.equal(playbackIssue('audio-playback', '读取失败', '', 'profile_unavailable').stage, 'account')
  assert.equal(playbackIssue('audio-playback', '后台加载超时', '', 'source_timeout').stage, 'audio-source')
  const upstream = playbackIssue('video-source', { code: 'provider_error', message: 'Bilibili 接口返回错误 -412: 限流' }, '')
  assert.equal(upstream.code, 'bili_api:-412')
  assert.equal(upstream.stage, 'video-source')
  assert.equal(playbackIssue('audio-playback', '播放账号已变更，请重新播放', '', 'account_changed').stage, 'account')
})

test('copied details exclude raw responses and signed URLs', () => {
  const issue = playbackIssue('video-source', { code: 'untrusted_token_123', message: 'HTTP 403 https://cdn.test/private?auth=secret' }, '视频线路暂不可用')
  const details = playbackDiagnosticText(issue, { version: '0.4.0', platform: 'Android', bvid: 'BV1JX73ztEEo',
    cid: 7, codecs: 'avc1.64001e', webView: '113.0.5672.136' })
  assert.match(details, /http:403/)
  assert.match(details, /BV BV1JX73ztEEo/)
  assert.match(details, /CID 7/)
  assert.match(details, /avc1.64001e/)
  assert.doesNotMatch(details, /cdn\.test|secret|untrusted_token_123/)
  assert.equal(playbackIssue('audio-playback', '播放失败', '', 'ios_media:untrusted_domain:-1').code, undefined)
})
