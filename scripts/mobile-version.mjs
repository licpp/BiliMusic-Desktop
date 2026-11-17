import {readFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

// Preview builds reserve the integer immediately before the next stable release.
// iOS requires numeric build components: previews use iteration 1–98, stable 99.
// The visible app version retains SemVer; CFBundleShortVersionString stays numeric.
export function mobileVersion(version) {
  const match=/^(\d+)\.(\d+)\.(\d+)(?:-preview(?:\.(\d+))?)?$/.exec(version)
  if(!match)throw new Error('Mobile builds support stable versions or -preview[.N] versions.')
  const [major,minor,patch]=match.slice(1,4).map(Number)
  const preview=version.includes('-preview'),iteration=Number(match[4] || 1)
  if(preview && (iteration<1 || iteration>98))throw new Error('iOS preview iteration must be 1–98.')
  const stable=`${major}.${minor}.${patch}`
  const code=major*1_000_000+minor*10_000+patch*100-(preview?1:0)
  if(!Number.isSafeInteger(code)||code<=0||code>2_100_000_000)throw new Error('Invalid Android version code.')
  if(major*100+minor>9999 || minor>99 || patch>99)throw new Error('Version exceeds iOS numeric component limits.')
  return {version,nativeVersion:stable,androidVersionCode:code,iosBundleVersion:`${major*100+minor}.${patch}.${preview?iteration:99}`,preview}
}
export async function syncMobileVersion(root=new URL('../',import.meta.url)) {
  const info=mobileVersion(JSON.parse(await readFile(new URL('package.json',root),'utf8')).version)
  for(const [file,platform,field,value] of [['tauri.android.conf.json','android','versionCode',info.androidVersionCode],['tauri.large-screen.conf.json','android','versionCode',info.androidVersionCode],['tauri.ios.conf.json','iOS','bundleVersion',info.iosBundleVersion]]) {
    const path=new URL(`src-tauri/${file}`,root),config=JSON.parse(await readFile(path,'utf8'))
    config.bundle ??={};config.bundle[platform]??={};config.bundle[platform][field]=value
    await writeFile(path,JSON.stringify(config,null,2)+'\n')
  }
  return info
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await syncMobileVersion()))
