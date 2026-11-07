import { readdir, mkdir, mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '..')
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const output = resolve(process.argv[2] || join(root, 'src-tauri/target/ios-unsigned'))
const archives = []
async function find(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.name.endsWith('.xcarchive')) archives.push(path)
    else if (entry.name !== 'DerivedData') await find(path)
  }
}
await find(join(root, 'src-tauri/gen/apple'))
if (archives.length !== 1) throw new Error(`Expected one device archive, found ${archives.length}. Start with a clean iOS build directory.`)
const appsRoot = join(archives[0], 'Products/Applications')
const apps = (await readdir(appsRoot)).filter(name => name.endsWith('.app'))
if (apps.length !== 1) throw new Error('Expected one iPhone application')
const temp = await mkdtemp(join(tmpdir(), 'bilimusic-ipa-'))
function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${cmd}: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}
try {
  const app = join(temp, 'Payload', 'BiliMusic.app')
  await mkdir(join(temp, 'Payload'))
  await cp(join(appsRoot, apps[0]), app, { recursive: true })
  const plist = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', join(app, 'Info.plist')]))
  if (plist.CFBundleShortVersionString !== version || plist.CFBundleIdentifier !== 'app.bilimusic.ios') throw new Error('iOS bundle identity/version mismatch')
  if (!plist.CFBundleSupportedPlatforms?.includes('iPhoneOS')) throw new Error('A real-device build is required, not a simulator')
  if (!plist.UIBackgroundModes?.includes('audio')) throw new Error('Background audio capability is missing')
  const arch = run('lipo', ['-archs', join(app, plist.CFBundleExecutable)])
  if (arch !== 'arm64') throw new Error(`Unexpected device architectures: ${arch}`)
  // An unsigned IPA is input for AltStore/SideStore/Sideloadly, not a directly installable app.
  await rm(join(app, 'embedded.mobileprovision'), { force: true })
  await rm(join(app, '_CodeSignature'), { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  const filename = `BiliMusic_${version}_iOS_arm64-unsigned.ipa`
  const path = join(output, filename)
  await rm(path, { force: true })
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(temp, 'Payload'), path])
  const bytes = await readFile(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const source = run('git', ['-C', root, 'rev-parse', 'HEAD'])
  await writeFile(join(output, 'SHA256SUMS.txt'), `${sha256}  ${filename}\n`)
  await writeFile(join(output, 'build-info.json'), JSON.stringify({ version, source, signed: false, platform: 'iOS', architecture: arch, minimumSystemVersion: plist.MinimumOSVersion, bytes: bytes.length, sha256 }, null, 2) + '\n')
  console.log(JSON.stringify({ path, bytes: bytes.length, sha256, source }))
} finally { await rm(temp, { recursive: true, force: true }) }
