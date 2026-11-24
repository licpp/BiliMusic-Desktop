import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const output = await build({ stdin: { resolveDir: process.cwd(), contents: `
  export * from './src/features/player/playbackIssue.ts'
  export * from './src/services/diagnosticEnvironment.ts'
` }, bundle: true, write: false, format: 'esm' })
const { playbackIssue, playbackDiagnosticText, describeDiagnosticEnvironment, formatDiagnosticEnvironment } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

test('playback diagnostics preserve native, upstream and account errors with the correct stage', () => {
  const mediaServer = playbackIssue('audio-playback', 'Android 媒体服务已中断，请重新播放', '', 'android_media:100:1')
  assert.equal(mediaServer.code, 'android_media:100:1')
  assert.equal(mediaServer.stage, 'audio-playback')
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
  const environment = describeDiagnosticEnvironment('Android', 'Android 10 Chrome/120.0.0.0 https://private.test/', {
    osVersion: '9', apiLevel: 28, osBuild: 'PQ3B.190801.002', deviceModel: '车机 https://private.test/', architecture: 'arm',
    webviewVersion: '113.0.5672.136', webviewPackage: 'com.android.webview',
  }, true)
  const details = playbackDiagnosticText(issue, { version: '0.4.2.4', environment, bvid: 'BV1JX73ztEEo', cid: 7, codecs: 'avc1.64001e' })
  assert.match(details, /BiliMusic 0\.4\.2\.4 · 车机 \/ TV/)
  assert.match(details, /系统 Android 9\n系统构建 PQ3B\.190801\.002\n系统 API 28/)
  assert.match(details, /应用架构 arm\nWebView Android WebView 113\.0\.5672\.136\nWebView 包 com\.android\.webview/)
  assert.match(details, /http:403/)
  assert.match(details, /BV BV1JX73ztEEo/)
  assert.match(details, /CID 7/)
  assert.match(details, /avc1.64001e/)
  assert.doesNotMatch(details, /cdn\.test|secret|untrusted_token_123|private\.test|120\.0\.0\.0/)
  assert.equal(playbackIssue('audio-playback', '播放失败', '', 'ios_media:untrusted_domain:-1').code, undefined)
})

test('native versions distinguish Windows releases and bypass reduced Apple user agents', () => {
  const windows = describeDiagnosticEnvironment('Windows', 'Windows NT 10.0 Chrome/133.0.0.0', {
    osName: 'Windows 11', osVersion: '24H2', osBuild: '26100.3194', webviewVersion: '133.0.3065.82',
  })
  assert.equal(windows.system, 'Windows 11 24H2')
  assert.equal(windows.systemBuild, '26100.3194')
  assert.equal(windows.webview, 'WebView2 133.0.3065.82')
  const ipad = describeDiagnosticEnvironment('iOS', 'Macintosh; Intel Mac OS X 10_15_7 AppleWebKit/605.1.15', {
    osName: 'iPadOS', osVersion: '18.7.1', webviewVersion: '20621.2.5.18.5',
  })
  assert.equal(ipad.system, 'iPadOS 18.7.1')
  assert.equal(ipad.webview, 'WKWebView 20621.2.5.18.5')
  const debian = describeDiagnosticEnvironment('Linux', 'Linux x86_64 AppleWebKit/605.1.15', {
    osName: 'Debian GNU/Linux', osVersion: '13', webviewVersion: '2.50.4',
  })
  assert.equal(debian.system, 'Debian GNU/Linux 13')
  assert.equal(debian.webview, 'WebKitGTK 2.50.4')
})

test('fallback identifies ArkWeb and marks reduced browser values as user-agent data', () => {
  const ohos = describeDiagnosticEnvironment('HarmonyOS', 'OpenHarmony 5.0 Chrome/114.0.0.0 ArkWeb/4.1.6.1')
  assert.equal(ohos.system, 'HarmonyOS 5.0（UA）')
  assert.equal(ohos.webview, 'ArkWeb 4.1.6.1（UA）')
  const android = describeDiagnosticEnvironment('Android', 'Android 10 Chrome/96.0.4664.45')
  assert.equal(android.system, 'Android 10（UA）')
  assert.equal(android.webview, 'Android WebView 96.0.4664.45（UA）')
})

test('copying a failed recovery identifies the underlying media error and the precise source stage', () => {
  const issue = playbackIssue('audio-playback', '分 P 已变更', '', 'invalid_input', 'android_media:100:1')
  const environment = describeDiagnosticEnvironment('Android', 'Android 15 Chrome/144.0.7559.132')
  const diagnostic = playbackDiagnosticText(issue, { version: '0.4.2.3', environment, bvid: 'BV17J411z74y', cid: 132935513, playbackSource: 'B 站收藏夹' })
  assert.match(diagnostic, /阶段 audio-source\n错误码 invalid_input\n首次播放错误 android_media:100:1\n播放来源 B 站收藏夹\nBV BV17J411z74y\nCID 132935513/)
})

test('device report is independent of playback and includes the full app build', () => {
  const environment = describeDiagnosticEnvironment('Android', 'Android 15 Chrome/144.0.7559.132', {
    osVersion: '15', osBuild: 'AP3A.241105.007', apiLevel: 35,
    deviceModel: 'Sample Tablet', architecture: 'aarch64', webviewPackage: 'com.google.android.webview',
  }, true)
  const report = formatDiagnosticEnvironment('0.4.2.3', environment)
  assert.match(report, /BiliMusic 0\.4\.2\.3 · 车机 \/ TV/)
  assert.match(report, /系统 API 35\n设备型号 Sample Tablet\n应用架构 aarch64/)
  assert.match(report, /WebView Android WebView 144\.0\.7559\.132（UA）\nWebView 包 com\.google\.android\.webview/)
  assert.doesNotMatch(report, /BV |CID |Cookie|token/)
})

test('the playback report keeps the original track even when another track is displayed', () => {
  const issue = playbackIssue('audio-playback', '分 P 已变更', '', 'cid_mismatch', 'android_media:100:1')
  issue.diagnostic = { operation: 'fc92bff0-c964-43ad-bda1-7c6c542e7109', bvid: 'BV1JX73ztEEo', cid: 9, engine: 'android-media-player', source: 'cache' }
  const environment = describeDiagnosticEnvironment('Android', 'Android 15 Chrome/144.0.7559.132')
  const report = playbackDiagnosticText(issue, { version: '0.4.2.3', environment, bvid: 'BV17J411z74y', cid: 888 })
  assert.match(report, /诊断编号 fc92bff0-c964-43ad-bda1-7c6c542e7109/)
  assert.match(report, /播放器 android-media-player\n音视频来源 cache\n阶段 audio-source/)
  assert.match(report, /错误码 cid_mismatch\n首次播放错误 android_media:100:1/)
  assert.match(report, /BV BV1JX73ztEEo\nCID 9/)
  assert.doesNotMatch(report, /BV17J411z74y|CID 888/)
})
