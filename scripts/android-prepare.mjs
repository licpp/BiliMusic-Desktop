// Run after `tauri android init`. Keep generated Gradle scaffolding reproducible.
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { editionManifest } from './android-manifest.mjs'
import { jniKeepRules, patchRustWebViewFile } from './android-glue.mjs'
const base = new URL('../src-tauri/gen/android/app/src/main/', import.meta.url)
const largeScreen = process.argv.includes('--large-screen')
const appPackage = largeScreen ? 'app.bilimusic.large' : 'app.bilimusic.mobile'
const generatedWebView = `java/${appPackage.replaceAll('.', '/')}/generated/RustWebView.kt`

// The release shrinker does not see Rust's JNI calls into the wry glue and would
// strip the methods they target. `app/build.gradle.kts` applies every `.pro` file
// in the app directory, so this file lands in the release build automatically.
await writeFile(
  new URL('../src-tauri/gen/android/app/proguard-bilimusic-jni.pro', import.meta.url),
  jniKeepRules(appPackage),
)
console.log('Android: the wry JNI glue is kept through release shrinking.')

// A login page has no cookies yet, so the first `cookies_for_url` gets null from
// the platform and the non-null Kotlin return would crash the app. wry writes the
// glue while the Rust library builds, so it may not exist yet; the Gradle hook
// below patches it again before Kotlin compiles.
const rustWebView = new URL(generatedWebView, base)
if (await patchRustWebViewFile(rustWebView)) {
  console.log('Android: an empty cookie lookup returns an empty string instead of crashing.')
}

const appGradle = new URL('../src-tauri/gen/android/app/build.gradle.kts', import.meta.url)
const glueHook = '// scripts/android-glue.mjs: patch the wry glue before Kotlin compiles it'
const gradle = await readFile(appGradle, 'utf8')
if (!gradle.includes(glueHook)) {
  await writeFile(appGradle, gradle + `
${glueHook}
// wry writes RustWebView.kt while the Rust library builds, after this project was
// prepared, so patch it once more right before Kotlin compiles it.
val patchWryGlue = tasks.register<Exec>("patchWryGlue") {
    group = "rust"
    description = "Backport wry's empty-cookie fix into the generated RustWebView.kt"
    workingDir = rootProject.projectDir
    commandLine("node",
        file("../../../../scripts/android-glue.mjs").absolutePath,
        file("src/main/${generatedWebView}").absolutePath)
    mustRunAfter(tasks.matching { it.name.startsWith("rustBuild") })
}
tasks.matching { it.name.startsWith("compile") && it.name.endsWith("Kotlin") }.configureEach {
    dependsOn(patchWryGlue)
}
`)
}
console.log('Android: the Kotlin glue is patched before it compiles.')
const manifest = new URL('AndroidManifest.xml', base)
let xml = await readFile(manifest, 'utf8')
xml = editionManifest(xml, largeScreen)
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

if (largeScreen) {
  await mkdir(new URL('res/drawable/', base), { recursive: true })
  await cp(new URL('../assets/android/tv_banner.png', import.meta.url), new URL('res/drawable/tv_banner.png', base))
  const startup = new URL('../src-tauri/android/large-screen/', import.meta.url)
  await cp(new URL('MainActivity.kt', startup), new URL('java/app/bilimusic/large/MainActivity.kt', base))
  await cp(new URL('webview_preflight.xml', startup), new URL('res/values/webview_preflight.xml', base))
}
