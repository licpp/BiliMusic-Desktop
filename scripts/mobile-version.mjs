import {readFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

// Preview builds reserve the integer immediately before the next stable release.
// iOS requires numeric build components: previews use iteration 1–98, stable 99.
// The visible app version retains SemVer; CFBundleShortVersionString stays numeric.
export function mobileVersion(version, build = Number(process.env.BILIMUSIC_BUILD_NUMBER ?? '1')) {
  const match=/^(\d+)\.(\d+)\.(\d+)(?:-preview(?:\.(\d+))?)?$/.exec(version)
  if(!match)throw new Error('Mobile builds support stable versions or -preview[.N] versions.')
  const [major,minor,patch]=match.slice(1,4).map(Number)
  const preview=version.includes('-preview'),iteration=Number(match[4] || 1)
  const revised = major > 0 || minor >= 4
  const maxPreview = revised ? 49 : 98
  if (!Number.isInteger(build) || build < 1 || build > 50 || ((!revised || preview) && build !== 1)) throw new Error('Invalid platform build number.')
  if(preview && (iteration<1 || iteration>maxPreview))throw new Error(`iOS preview iteration must be 1–${maxPreview}.`)
  const stable=`${major}.${minor}.${patch}`
  const code=major*1_000_000+minor*10_000+patch*100+(preview?-1:build-1)
  if(!Number.isSafeInteger(code)||code<=0||code>2_100_000_000)throw new Error('Invalid Android version code.')
  // Use a higher numeric prefix than the pre-revision iOS test builds.
  const iosBranch = major*100+minor+(revised?1000:0)
  if(iosBranch>9999 || minor>99 || patch>99)throw new Error('Version exceeds iOS numeric component limits.')
  return {version,build,nativeVersion:stable,androidVersionCode:code,iosBundleVersion:`${iosBranch}.${patch}.${preview?iteration:revised?49+build:99}`,preview}
}
export async function syncMobileVersion(root=new URL('../',import.meta.url), edition) {
  const info=mobileVersion(JSON.parse(await readFile(new URL('package.json',root),'utf8')).version)
  for(const [file,platform,field,value] of [['tauri.android.conf.json','android','versionCode',info.androidVersionCode],['tauri.large-screen.conf.json','android','versionCode',info.androidVersionCode],['tauri.ios.conf.json','iOS','bundleVersion',info.iosBundleVersion]]) {
    if (edition && file !== `tauri.${edition}.conf.json`) continue
    const path=new URL(`src-tauri/${file}`,root),config=JSON.parse(await readFile(path,'utf8'))
    config.bundle ??={};config.bundle[platform]??={};config.bundle[platform][field]=value
    await writeFile(path,JSON.stringify(config,null,2)+'\n')
  }
  return info
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await syncMobileVersion(undefined, process.argv[2])))
