// Run after `tauri android init`. Keep generated Gradle scaffolding reproducible.
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { editionManifest } from './android-manifest.mjs'
import { jniKeepRules, patchEmptyCookies } from './android-glue.mjs'
const base = new URL('../src-tauri/gen/android/app/src/main/', import.meta.url)

// The release shrinker does not see Rust's JNI calls into the wry glue and would
// strip the methods they target. `app/build.gradle.kts` applies every `.pro` file
// in the app directory, so this file lands in the release build automatically.
await writeFile(
  new URL('../src-tauri/gen/android/app/proguard-bilimusic-jni.pro', import.meta.url),
  jniKeepRules('app.bilimusic.mobile'),
)
console.log('Android: the wry JNI glue is kept through release shrinking.')

// A login page has no cookies yet, so the first `cookies_for_url` gets null from
// the platform and the non-null Kotlin return would crash the app.
const rustWebView = new URL('java/app/bilimusic/mobile/generated/RustWebView.kt', base)
const rustWebViewSource = await readFile(rustWebView, 'utf8')
const patchedRustWebView = patchEmptyCookies(rustWebViewSource)
if (patchedRustWebView !== rustWebViewSource) await writeFile(rustWebView, patchedRustWebView)
console.log('Android: an empty cookie lookup returns an empty string instead of crashing.')
const manifest = new URL('AndroidManifest.xml', base)
let xml = await readFile(manifest, 'utf8')
xml = editionManifest(xml, process.argv.includes('--large-screen'))
xml = xml.replace(/ android:networkSecurityConfig="[^"]*"/g, '')
xml = xml.replace(/<application\b/, '<application android:networkSecurityConfig="@xml/bilimusic_network_security"')
// Keep the current WebView and video when the app requests landscape.
xml = xml.replace(/<activity\b[^>]*>/g, activity => {
  if (!/android:name="[^"]*(?:MainActivity|CarPlayerActivity)"/.test(activity)) return activity
  const existing = activity.match(/android:configChanges="([^"]*)"/)
  const changes = new Set([...(existing?.[1].split('|') || []), 'orientation', 'screenSize', 'screenLayout', 'smallestScreenSize'])
  const attribute = `android:configChanges="${[...changes].join('|')}"`
  return existing ? activity.replace(existing[0], attribute) : activity.replace('<activity', `<activity ${attribute}`)
})
await writeFile(manifest, xml)
await mkdir(new URL('res/xml/', base), { recursive: true })
await writeFile(new URL('res/xml/bilimusic_network_security.xml', base), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /></trust-anchors></base-config>
  <domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain><domain includeSubdomains="false">localhost</domain></domain-config>
</network-security-config>
`)
console.log('Android: cleartext allowed only for the on-device media proxy.')

await cp(new URL('../src-tauri/.android-icons/android/', import.meta.url), new URL('res/', base), { recursive: true })

// Round launchers use the same safe foreground/background as other adaptive masks.
const adaptive = await readFile(new URL('res/mipmap-anydpi-v26/ic_launcher.xml', base), 'utf8')
await writeFile(new URL('res/mipmap-anydpi-v26/ic_launcher_round.xml', base), adaptive)

if (process.argv.includes('--large-screen')) {
  await mkdir(new URL('res/drawable/', base), { recursive: true })
  await cp(new URL('../assets/android/tv_banner.png', import.meta.url), new URL('res/drawable/tv_banner.png', base))
  const startup = new URL('../src-tauri/android/large-screen/', import.meta.url)
  await cp(new URL('MainActivity.kt', startup), new URL('java/app/bilimusic/large/MainActivity.kt', base))
  await cp(new URL('webview_preflight.xml', startup), new URL('res/values/webview_preflight.xml', base))
}
