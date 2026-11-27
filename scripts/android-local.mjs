import { syncMobileVersion } from './mobile-version.mjs'
// Project-scoped Android environment; does not change the shell's global Java.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { androidLargeScreenTarget, androidTarget } from './android-target.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const isWindows = process.platform === 'win32'
const exe = isWindows ? '.exe' : ''
const bat = isWindows ? '.bat' : ''
const npm = isWindows ? 'npm.cmd' : 'npm'
const task = process.argv[2] ?? 'doctor'
if (!['doctor', 'init', 'build', 'test', 'dev', 'large-screen'].includes(task)) throw new Error('Use: npm run android:local -- doctor|init|build|test|dev|large-screen [arguments]')
const extras = process.argv.slice(3)
const selected = task === 'large-screen' ? androidLargeScreenTarget(extras) : androidTarget(['doctor', 'build'].includes(task) ? extras : [])
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library/Android/sdk')
const jdkRoot = join(homedir(), 'Library/Java/JavaVirtualMachines')
const candidates = [process.env.BILIMUSIC_ANDROID_JAVA_HOME, process.env.JAVA_HOME,
  ...(existsSync(jdkRoot) ? readdirSync(jdkRoot).sort().reverse().map(name => join(jdkRoot, name, 'Contents/Home')) : [])]
const java = candidates.find(path => path && existsSync(join(path, 'bin', `javac${exe}`)) && existsSync(join(path, 'release')) &&
  /^JAVA_VERSION="17(?:\.|\")/m.test(readFileSync(join(path, 'release'), 'utf8')))
if (!java) throw new Error('JDK 17 not found. Install it in ~/Library/Java/JavaVirtualMachines or set BILIMUSIC_ANDROID_JAVA_HOME.')
const ndk = process.env.NDK_HOME || join(sdk, 'ndk/27.2.12479018')
const env = { ...process.env, JAVA_HOME: java, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, NDK_HOME: ndk,
  PATH: [join(java, 'bin'), join(sdk, 'platform-tools'), join(sdk, 'cmdline-tools/latest/bin'), process.env.PATH].join(delimiter) }
// Gradle does not read HTTPS_PROXY itself. Forward an unauthenticated HTTP proxy
// to this child JVM only, keeping the user's global Gradle settings untouched.
const proxyValue = process.env.HTTPS_PROXY || process.env.https_proxy
if (proxyValue) {
  const proxy = new URL(proxyValue)
  if (proxy.protocol === 'http:' && !proxy.username && !proxy.password && /^[\w.:[\]-]+$/.test(proxy.hostname)) {
    const port = proxy.port || '80'
    env.JAVA_TOOL_OPTIONS = [env.JAVA_TOOL_OPTIONS, `-Dhttp.proxyHost=${proxy.hostname}`, `-Dhttp.proxyPort=${port}`,
      `-Dhttps.proxyHost=${proxy.hostname}`, `-Dhttps.proxyPort=${port}`, '-Dhttp.nonProxyHosts=localhost|127.*|[::1]'].filter(Boolean).join(' ')
  }
}

function run(command, args, cwd = root) {
  // Node on Windows cannot spawn .cmd/.bat directly without a shell.
  const shell = isWindows && /\.(bat|cmd)$/i.test(command)
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
function check() {
  const required = [join(sdk, `cmdline-tools/latest/bin/sdkmanager${bat}`), join(sdk, `platform-tools/adb${exe}`),
    join(sdk, 'platforms/android-36/android.jar'), join(sdk, `build-tools/36.0.0/apksigner${bat}`), join(ndk, 'source.properties')]
  const missing = required.filter(path => !existsSync(path))
  if (missing.length) throw new Error(`Android components missing:\n${missing.join('\n')}`)
  const rust = spawnSync('rustup', ['target', 'list', '--installed'], { cwd: root, env, encoding: 'utf8' })
  if (rust.error) throw rust.error
  const installed = rust.stdout?.split(/\r?\n/) ?? []
  const missingTargets = selected.rust.filter(target => !installed.includes(target))
  if (rust.status !== 0) throw new Error(rust.stderr || 'Could not list installed Rust targets.')
  if (missingTargets.length) throw new Error(`Run rustup target add ${missingTargets.join(' ')} first.`)
  console.log(`JDK: ${java}\nSDK: ${sdk}\nNDK: ${ndk}\nRust: ${selected.rust.join(', ')}`)
}

if (task === 'build') await syncMobileVersion(undefined, 'android')
check()
if (task === 'doctor') {
  run(join(java, 'bin', `java${exe}`), ['-version'])
  run(join(sdk, `platform-tools/adb${exe}`), ['version'])
  console.log('Android local build environment is ready.')
} else if (task === 'large-screen') {
  run('node', ['scripts/android-large-screen.mjs', ...extras])
} else {
  const generated = join(root, 'src-tauri/gen/android')
  if (task === 'init' || !existsSync(join(generated, `gradlew${bat}`))) run(npm, ['run', 'android:init'])
  else if (task === 'build' || task === 'dev') run('node', ['scripts/android-prepare.mjs'])
  if (task === 'build') run(npm, ['run', 'tauri', '--', 'android', 'build', '--apk', '--target', ...selected.targets, ...selected.args])
  if (task === 'dev') run(npm, ['run', 'tauri', '--', 'android', 'dev', ...extras])
  if (task === 'test') run(join(generated, `gradlew${bat}`), [':tauri-plugin-android-player:testReleaseUnitTest', '--no-daemon', ...extras], generated)
}
