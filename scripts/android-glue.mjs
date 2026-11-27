// wry's Android glue is reached from Rust through JNI, by class and method name.
// Two things about it bite release builds; both are fixed by patching the glue
// after `tauri android init` rather than editing it by hand. wry writes the glue
// files during the Rust build, so `patchRustWebViewFile` also runs from Gradle
// right before Kotlin compiles them.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// 1. The release shrinker cannot see JNI calls and would strip the methods they
// target. wry ships `proguard-wry.pro`, but its `RustWebView` rule only lists the
// methods that existed when it was written: wry 0.55 added `getCookies` (what
// `cookies_for_url` calls) and `clearAllBrowsingData`, so R8 removed both and the
// first Android NetEase web login died with NoSuchMethodError. Keep every member
// of the glue instead of an allowlist of methods.
export const WRY_GLUE_CLASSES = [
  'Ipc',
  'Logger',
  'PermissionHelper',
  'RustWebChromeClient',
  'RustWebView',
  'RustWebViewClient',
  'WryActivity',
]

export function jniKeepRules(packageName, classes = WRY_GLUE_CLASSES) {
  return [
    '# THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!!',
    '',
    '# Rust loads these classes and calls their methods through JNI, which the',
    '# shrinker cannot see. Keep all members so release builds behave like debug.',
    ...classes.map(name => `-keep class ${packageName}.${name} { *; }`),
    '',
  ].join('\n')
}

// 2. `CookieManager.getCookie` returns null when the URL has no cookies, but the
// Kotlin method is declared to return a non-null String, so Kotlin's null check
// throws inside the JNI-called method and takes the app down. That is exactly the
// state of a freshly opened login page, so `cookies_for_url` crashed on its first
// poll. Backport of wry #1838 (`?: ""`, released in wry 0.57).
const EMPTY_COOKIE_FALLBACK = '?: ""'

export function patchEmptyCookies(kotlin) {
  if (kotlin.includes(EMPTY_COOKIE_FALLBACK)) return kotlin
  const patched = kotlin.replace(
    'return cookieManager.getCookie(url)',
    '// getCookie returns null when the URL has no cookies yet; the JNI return\n' +
      '        // type is non-null, so Kotlin would crash instead of reporting no login.\n' +
      '        return cookieManager.getCookie(url) ?: ""',
  )
  if (patched === kotlin) {
    throw new Error(
      'Android: 没有在 RustWebView.getCookies 里找到预期的 getCookie 调用，' +
        '无法补上空 Cookie 时返回空串的修复；请对照新版 wry 的 RustWebView.kt 更新 scripts/android-glue.mjs。',
    )
  }
  return patched
}

// wry only writes the glue while the Rust library compiles, so on a fresh
// `tauri android init` the file is not there yet; the Gradle hook patches it
// later. Returns whether anything was changed.
export async function patchRustWebViewFile(path) {
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  const patched = patchEmptyCookies(source)
  if (patched === source) return false
  await writeFile(path, patched)
  return true
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2]
  if (!target) throw new Error('usage: node scripts/android-glue.mjs <RustWebView.kt>')
  if (await patchRustWebViewFile(target)) {
    console.log('Android: an empty cookie lookup returns an empty string instead of crashing.')
  }
}
