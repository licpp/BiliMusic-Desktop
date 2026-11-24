// Build a disposable source snapshot. Never rewrite the phone's generated app.
import { cp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { androidLargeScreenTarget } from './android-target.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const selected = androidLargeScreenTarget(process.argv.slice(2))
const workspace = join(root, 'artifacts/build/large-screen/source', selected.label)
const cache = join(root, 'artifacts/build/large-screen/cargo')
const config = 'src-tauri/tauri.large-screen.conf.json'
const env = { ...process.env, CARGO_TARGET_DIR: cache }
const excluded = new Set(['.git', '.env', 'node_modules', 'target', 'gen', 'build', '.gradle', '.build', '.swiftpm', '.tauri', '.android-icons', '.ios-icons', '.DS_Store'])
function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspace, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`Build command failed (${result.status}): ${command}`)
}
await rm(workspace, { recursive: true, force: true })
await mkdir(workspace, { recursive: true })
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'large-screen.html', 'src', 'src-tauri', 'native', 'public', 'assets', 'scripts']) {
  await cp(join(root, name), join(workspace, name), { recursive: true, filter: path => !excluded.has(basename(path)) && !basename(path).startsWith('.env.') })
}
await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), 'dir')
run('node', ['scripts/mobile-version.mjs', 'large-screen'])
run('npm', ['run', 'tauri', '--', 'icon', 'assets/android/icon.json', '--output', 'src-tauri/.android-icons'])
run('npm', ['run', 'tauri', '--', 'android', 'init', '--ci', '--skip-targets-install', '--config', config])
run('node', ['scripts/android-prepare.mjs', '--large-screen'])
const debug = selected.args.includes('--debug') || selected.args.includes('-d')
// Tauri's build script writes Kotlin into the generated project. A cached
// build from another snapshot can leave those files missing in this one.
for (const rust of selected.rust) {
  run('cargo', ['clean', '--manifest-path', 'src-tauri/Cargo.toml', '-p', 'tauri', '--target', rust, ...(debug ? [] : ['--release'])])
}
run('npm', ['run', 'tauri', '--', 'android', 'build', '--apk', '--target', ...selected.targets, '--config', config, ...selected.args])
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const outputs = join(workspace, 'src-tauri/gen/android/app/build/outputs/apk/universal', debug ? 'debug' : 'release')
const apks = (await readdir(outputs)).filter(name => name.endsWith('.apk'))
if (apks.length !== 1) throw new Error(`Expected one large-screen APK in ${outputs}`)
const apk = join(outputs, apks[0])
const zip = spawnSync('unzip', ['-Z1', apk], { encoding: 'utf8' })
if (zip.error) throw zip.error
const entries = zip.stdout?.split(/\r?\n/) ?? []
const abis = new Set(entries.map(name => /^lib\/([^/]+)\/[^/]+\.so$/.exec(name)?.[1]).filter(Boolean))
if (zip.status !== 0 || abis.size !== selected.abis.length ||
    !selected.abis.every(abi => entries.includes(`lib/${abi}/libbilimusic_lib.so`))) {
  throw new Error(`APK must contain exactly these native builds: ${selected.abis.join(', ')}`)
}
const destination = join(root, `artifacts/BiliMusic-${version}-Android-LargeScreen`)
await mkdir(destination, { recursive: true })
const target = join(destination, `BiliMusic_${version}_Android_LargeScreen_${selected.label}${debug ? '-debug' : '-unsigned'}.apk`)
await cp(apk, target)
console.log(`Large-screen APK: ${target}`)
