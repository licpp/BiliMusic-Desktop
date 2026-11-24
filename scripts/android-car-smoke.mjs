// Run on a disposable AVD created specifically for the car edition.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const [serial, apk, abi, output, bvid] = process.argv.slice(2)
if (!/^emulator-\d+$/.test(serial || '') || !apk || !output ||
    !['arm64-v8a', 'armeabi-v7a'].includes(abi) || (bvid && !/^BV[A-Za-z0-9]{10}$/.test(bvid))) {
  throw new Error('Usage: node scripts/android-car-smoke.mjs EMULATOR SIGNED_APK ABI OUTPUT_DIR [BVID]')
}

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library/Android/sdk')
const adb = join(sdk, 'platform-tools/adb')
const app = 'app.bilimusic.large'
const onDevice = (...args) => execFileSync(adb, ['-s', serial, ...args], {
  timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
})
const shell = (...args) => onDevice('shell', ...args).toString().trim()
const avd = onDevice('emu', 'avd', 'name').toString().split(/\r?\n/)[0]
assert.match(avd, /^BiliMusicCar[\w-]+$/, 'Use a dedicated BiliMusicCar AVD')
assert.equal(shell('getprop', 'sys.boot_completed'), '1')

const report = {
  avd,
  api: shell('getprop', 'ro.build.version.sdk'),
  webview: shell('dumpsys', 'webviewupdate').match(/Current WebView package.*$/m)?.[0],
  supportedABIs: shell('getprop', 'ro.product.cpu.abilist').split(','),
  abi,
}
mkdirSync(output, { recursive: true })
let port, socket, evaluate
try {
  const buildTools = process.env.ANDROID_BUILD_TOOLS || join(sdk, 'build-tools/36.0.0')
  const badging = execFileSync(join(buildTools, 'aapt'), ['dump', 'badging', apk]).toString()
  assert.match(badging, /^package: name='app\.bilimusic\.large'/m)
  onDevice('install', '-r', '--abi', abi, apk)
  const installed = shell('dumpsys', 'package', app)
  report.installedABI = installed.match(/primaryCpuAbi=(\S+)/)?.[1]
  assert.equal(report.installedABI, abi)
  shell('am', 'force-stop', app)
  assert.match(shell('am', 'start', '-W', '-n', app + '/.MainActivity'), /Status: ok/)
  const pid = shell('pidof', app).split(' ')[0]
  assert.match(pid, /^\d+$/)
  port = onDevice('forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + pid).toString().trim()

  let page
  for (let attempt = 0; attempt < 30 && !page; attempt++) {
    try {
      [page] = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()
    } catch {
      await wait(300)
    }
  }
  assert.ok(page?.webSocketDebuggerUrl, 'The test APK must permit WebView inspection')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) })
  evaluate = expression => new Promise((resolve, reject) => {
    const id = evaluate.id = (evaluate.id || 0) + 1
    function receive(event) {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      socket.removeEventListener('message', receive)
      clearTimeout(timeout)
      const failure = message.result?.exceptionDetails
      if (message.error || failure) reject(new Error(failure?.exception?.description || failure?.text || message.error?.message))
      else resolve(message.result?.result?.value)
    }
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', receive)
      reject(new Error('WebView evaluation timed out'))
    }, 35_000)
    socket.addEventListener('message', receive)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })

  async function visible(selector, attempts = 30) {
    const query = `document.querySelector(${JSON.stringify(selector)})`
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await evaluate(`Boolean(${query})`)) return query
      await wait(300)
    }
    const detail = await evaluate('document.body.innerText.slice(0, 320)')
    throw new Error(`Missing ${selector} on the car screen. ${detail}`)
  }

  async function click(selector) {
    await evaluate(`${await visible(selector)}.click()`)
  }

  await visible('.large-home')
  report.home = true
  report.appVersion = await evaluate('document.querySelector(".large-version").textContent')
  report.webviewUA = await evaluate('navigator.userAgent')
  report.frontend = await evaluate(`fetch('/frontend-build.json').then(response => response.json())
    .then(({edition, platform, target}) => ({edition, platform, target}), () => null)`)
  if (report.frontend) {
    assert.deepEqual(report.frontend, { edition: 'large-screen', platform: 'android', target: 'chrome66' })
  }
  writeFileSync(join(output, 'home.png'), onDevice('exec-out', 'screencap', '-p'))
  await click('[data-focus="nav-library"]')
  await visible('[data-focus="nav-library"][aria-current="page"]')
  report.nativeDatabase = await evaluate(
    'window.__TAURI_INTERNALS__.invoke("library_tracks", { favoritesOnly: false, savedOnly: false }).then(Array.isArray)',
  )
  assert.equal(report.nativeDatabase, true)
  await click('[data-focus="nav-search"]')
  await visible('form.large-search input')
  report.search = true
  await click('[data-focus="nav-settings"]')
  await visible('[data-focus="nav-settings"][aria-current="page"]')
  report.settings = true

  if (bvid) {
    await click('[data-focus="nav-search"]')
    const input = await visible('form.large-search input')
    await evaluate(`(function () {
      const input = ${input};
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(bvid)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await click('form.large-search button')
    await evaluate(`${await visible(`[data-focus="search-${bvid}"]`, 60)}.click()`)
    report.playback = await evaluate(`(async function () {
      const wait = () => new Promise(resolve => setTimeout(resolve, 400));
      for (let i = 0; i < 25; i++) {
        const play = Array.from(document.querySelectorAll('.large-main button')).find(button => button.textContent.trim() === '播放全部');
        if (play && !play.disabled) { play.click(); break; }
        await wait();
      }
      const invoke = window.__TAURI_INTERNALS__.invoke;
      let state;
      for (let i = 0; i < 45; i++) {
        state = await invoke('plugin:android-player|snapshot');
        if (state.id && state.id.includes(${JSON.stringify(bvid)}) && state.status === 'playing' && state.position > 1) break;
        await wait();
      }
      return { id: state.id, status: state.status, position: state.position, errorCode: state.errorCode };
    })()`)
    assert.ok(report.playback.id?.includes(bvid))
    assert.equal(report.playback.status, 'playing')
    assert.ok(report.playback.position > 1)
    await evaluate('localStorage.setItem("lyrics-media-mode", "cover")')
    await click('.large-dock-song')
    await click('[data-focus="player-video"]')
    await visible('.large-video')
    writeFileSync(join(output, 'video.png'), onDevice('exec-out', 'screencap', '-p'))
    await click('[data-focus="video-fullscreen"]')
    await visible('.large-video.expanded')
    report.fullscreen = true
    report.video = await evaluate(`(async function () {
      const wait = () => new Promise(resolve => setTimeout(resolve, 400));
      let video;
      for (let i = 0; i < 50; i++) {
        video = document.querySelector('.large-video video');
        if (video && video.classList.contains('ready') && video.videoWidth > 0) break;
        if (document.querySelector('.large-video .video-error')) break;
        await wait();
      }
      return video ? { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState,
        ready: video.classList.contains('ready'), seeking: video.seeking, errorCode: video.error && video.error.code } : null;
    })()`)
    writeFileSync(join(output, 'fullscreen.png'), onDevice('exec-out', 'screencap', '-p'))
    shell('input', 'keyevent', 'KEYCODE_BACK')
    if (await evaluate('Boolean(document.querySelector(".large-video.expanded"))')) {
      await click('.large-video-controls header button')
    }
    await visible('[data-focus="video-fullscreen"]')
    report.fullscreenExit = true
    await click('[data-focus="player-back"]')
    await visible('.large-dock')
    report.backToBrowsing = true
    assert.ok(report.video?.ready && report.video.width > 0 && report.video.height > 0,
      'The video must display a frame in fullscreen')
  }
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.failure = error.stderr?.toString().trim() || error.message
  throw error
} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  if (evaluate && socket?.readyState === WebSocket.OPEN && bvid) {
    try { await evaluate('window.__TAURI_INTERNALS__.invoke("plugin:android-player|control", {action:"pause"})') } catch {}
  }
  socket?.close()
  if (port) {
    try { onDevice('forward', '--remove', 'tcp:' + port) } catch {}
  }
}
