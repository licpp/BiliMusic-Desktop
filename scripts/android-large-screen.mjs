// Build a disposable source snapshot. Never rewrite the phone's generated app.
import { cp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { androidTarget } from './android-target.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const selected = androidTarget(process.argv.slice(2))
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
run('npm', ['run', 'tauri', '--', 'icon', 'assets/android/icon.json', '--output', 'src-tauri/.android-icons'])
run('npm', ['run', 'tauri', '--', 'android', 'init', '--ci', '--skip-targets-install', '--config', config])
run('node', ['scripts/android-prepare.mjs', '--large-screen'])
run('npm', ['run', 'tauri', '--', 'android', 'build', '--apk', '--target', selected.target, '--config', config, ...selected.args])
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const outputs = join(workspace, 'src-tauri/gen/android/app/build/outputs/apk')
async function packages(dir) { const entries = await readdir(dir, { withFileTypes: true }); return (await Promise.all(entries.map(e => e.isDirectory() ? packages(join(dir, e.name)) : e.name.endsWith('.apk') ? [join(dir, e.name)] : []))).flat() }
const destination = join(root, `artifacts/BiliMusic-${version}-Android-LargeScreen`)
await mkdir(destination, { recursive: true })
for (const apk of await packages(outputs)) { const target = join(destination, `BiliMusic_${version}_Android_LargeScreen_${selected.label}${apk.includes('/debug/') ? '-debug' : '-unsigned'}.apk`); await cp(apk, target); console.log(`Large-screen APK: ${target}`) }
