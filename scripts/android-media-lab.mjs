import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../artifacts/android-media-lab/', import.meta.url))
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library/Android/sdk')
const adb = join(sdk, 'platform-tools/adb')
const avd = 'BiliMusicMediaLab'
const app = 'app.bilimusic.mobile'
const service = app + '/app.bilimusic.player.PlaybackService'
const [action, serial, key] = process.argv.slice(2)
const keys = ['pause', 'play', 'play-pause', 'headsethook', 'previous', 'next']
const props = ['ro.product.manufacturer', 'ro.product.model', 'ro.build.version.sdk', 'ro.build.display.id',
  'ro.mi.os.version.incremental', 'ro.build.version.opporom', 'ro.vivo.os.version']

function run(command, args, options = {}) {
  const { input, env, interactive } = options
  const result = spawnSync(command, args, {
    input, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    timeout: interactive ? undefined : 30_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `${command} exited with ${result.status}`)
  return result.stdout?.trim() ?? ''
}

const onDevice = (...args) => run(adb, ['-s', serial, ...args])
const shell = (...args) => onDevice('shell', ...args)
const dump = name => shell('dumpsys', name)
const dispatch = value => shell('cmd', 'media_session', 'dispatch', value)
const hasApp = line => line.includes(app + '/') || line.includes(`package=${app}`)
const routedToApp = sessions => sessions.split('\n').some(line => line.includes('Media button session is') && hasApp(line))

function audioPlayers() {
  const uid = shell('cmd', 'package', 'list', 'packages', '-U', app).match(/uid:(\d+)/)?.[1]
  return uid ? dump('audio').split('\n').filter(line => line.includes(`u/pid:${uid}/`)) : []
}

function bluetoothMedia() {
  const bluetooth = dump('bluetooth_manager')
  const target = bluetooth.split(/^Profile: AvrcpTargetService:\s*$/m)[1]?.split(/^Profile:/m)[0]
  const controllers = target?.split('List of Browsers:')[0] ?? ''
  const players = controllers.split(/\n(?= *(?:<Active> *)?Media Player \d+:)/)
  const controller = players.find(player => player.split('\n')[0].trim().endsWith(': ' + app))
  return {
    avrcpTarget: target !== undefined,
    activePlayerIsBiliMusic: Boolean(controller?.trimStart().startsWith('<Active>')),
    controller: controller?.trim().split('\n').map(line => line.trim()) ?? [],
  }
}

function snapshot() {
  const sessions = dump('media_session')
  const sessionLines = sessions.split('\n')
  const routing = sessionLines.find(line => line.includes('Media button session is'))?.trim()
  const entries = sessions.split(/\n(?=\s{4}\S.*\(userId=)/).filter(entry => hasApp(entry.split('\n')[0]))
  const notifications = shell('dumpsys', 'notification', '--noredact').split(/\n(?= +NotificationRecord\()/)
    .filter(entry => /^ +NotificationRecord\(.*\bpkg=app\.bilimusic\.mobile\s/m.test(entry.split('\n')[0]))
    .flatMap(entry => entry.split('\n').filter(line =>
      /NotificationRecord\(|android\.(title|text|mediaSession)=/.test(line)))
  const info = Object.fromEntries(props.flatMap(name => {
    const value = shell('getprop', name)
    return value ? [[name, value]] : []
  }))
  return {
    device: info,
    mediaKeyTarget: !routing ? 'unknown' : hasApp(routing) ? 'BiliMusic' : routing.endsWith('null') ? 'none' : 'other',
    sessions: entries.map(entry => entry.split('\n').filter(line =>
      /\(userId=|active=|state=PlaybackState|audioAttrs=|metadata:|queueTitle=/.test(line))),
    audio: audioPlayers(),
    bluetooth: bluetoothMedia(),
    notifications,
    log: onDevice('logcat', '-d', '-t', '3000', '-s', 'BiliMusicPlayback:I'),
  }
}

function startEmulator(headless) {
  const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_AVD_HOME: join(root, 'avd'),
    JAVA_HOME: process.env.JAVA_HOME || join(homedir(), 'Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home') }
  mkdirSync(env.ANDROID_AVD_HOME, { recursive: true })
  const emulator = join(sdk, 'emulator/emulator')
  if (!run(emulator, ['-list-avds'], { env }).split('\n').includes(avd)) {
    run(join(sdk, 'cmdline-tools/latest/bin/avdmanager'), ['create', 'avd', '--name', avd,
      '--package', 'system-images;android-34;aosp_atd;arm64-v8a', '--device', 'pixel_6'], { env, input: 'no\n' })
  }
  run(emulator, ['-avd', avd, '-port', '5580', '-no-snapshot', '-gpu', 'swiftshader_indirect',
    ...(headless ? ['-no-window', '-no-audio'] : [])], { env, interactive: true })
}

function testAudio() {
  const sampleRate = 8000
  const data = Buffer.alloc(44 + sampleRate * 2 * 120)
  data.write('RIFF', 0)
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(sampleRate, 24)
  data.writeUInt32LE(sampleRate * 2, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(data.length - 44, 40)
  return data
}

async function waitForDeviceState(check, message) {
  for (let attempt = 0; attempt < 25; attempt++) {
    if (check()) return
    await delay(200)
  }
  throw new Error(message)
}

async function verify() {
  if (!/^emulator-\d+$/.test(serial) || onDevice('emu', 'avd', 'name').split(/\r?\n/)[0] !== avd) {
    throw new Error(`The synthetic playback test requires the ${avd} emulator`)
  }
  const rootWasEnabled = shell('id', '-u') === '0'
  const audio = testAudio()
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length })
    response.end(audio)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = 'tcp:' + server.address().port
  let forwarded = false
  try {
    if (!rootWasEnabled) {
      onDevice('root')
      onDevice('wait-for-device')
    }
    if (shell('id', '-u') !== '0') throw new Error('Use an AOSP userdebug emulator image')
    onDevice('reverse', '--no-rebind', port, port)
    forwarded = true
    shell('am', 'start-foreground-service', '-n', service, '-a', 'load',
      '--es', 'id', 'media-lab', '--es', 'title', 'BiliMusic-media-lab',
      '--es', 'artist', 'Media-lab-artist', '--es', 'album', 'Media-lab-album',
      '--es', 'url', `http://127.0.0.1:${server.address().port}/fixture.wav`,
      '--ez', 'playing', 'true')
    const currentState = () => {
      const media = dump('media_session')
      const index = media.indexOf(`package=${app}\n`)
      return index >= 0 ? media.slice(index).match(/    +state=PlaybackState \{state=(\w+)/)?.[1] : undefined
    }
    await waitForDeviceState(() => currentState() === 'PLAYING', 'Media3 did not publish PLAYING')
    await waitForDeviceState(() => routedToApp(dump('media_session')), 'Android did not select BiliMusic for media keys while playing')
    await waitForDeviceState(() => audioPlayers().some(line => line.includes('state:started')), 'AudioService did not register playback as started')
    console.log('PLAYING and selected for global media keys')
    for (const [button, expected] of [['pause', 'PAUSED'], ['play', 'PLAYING'],
      ['play-pause', 'PAUSED'], ['play-pause', 'PLAYING'],
      ['headsethook', 'PAUSED'], ['headsethook', 'PLAYING']]) {
      dispatch(button)
      await waitForDeviceState(() => currentState() === expected, `${button} did not produce ${expected}`)
      console.log(`${button} → ${expected}`)
    }
    await waitForDeviceState(() => routedToApp(dump('media_session')), 'System routing did not survive resume')
  } finally {
    try {
      if (forwarded) {
        const path = join(root, 'transport-state.json')
        try {
          writeFileSync(path, JSON.stringify(snapshot(), null, 2) + '\n')
          console.log(path)
        } finally {
          try {
            shell('am', 'startservice', '-n', service, '-a', 'stop')
          } finally {
            onDevice('reverse', '--remove', port)
          }
        }
      }
    } finally {
      server.closeAllConnections()
      server.close()
      if (!rootWasEnabled && shell('id', '-u') === '0') onDevice('unroot')
    }
  }
}

try {
  if (action === 'devices') console.log(run(adb, ['devices', '-l']))
  else if (action === 'start' && (!serial || serial === '--headless')) startEmulator(serial === '--headless')
  else if (serial && action === 'snapshot') console.log(JSON.stringify(snapshot(), null, 2))
  else if (serial && action === 'key' && keys.includes(key)) {
    if (!routedToApp(dump('media_session'))) throw new Error('Start playback and confirm Android has selected BiliMusic')
    dispatch(key)
  } else if (serial && action === 'verify') await verify()
  else throw new Error('Usage: android-media-lab.mjs devices | start [--headless] | snapshot SERIAL | key SERIAL BUTTON | verify EMULATOR_SERIAL')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
