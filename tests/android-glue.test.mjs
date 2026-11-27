import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jniKeepRules, patchEmptyCookies, patchRustWebViewFile, WRY_GLUE_CLASSES } from '../scripts/android-glue.mjs'

// Shape of wry 0.55.1's RustWebView.kt getCookies; wry 0.57 returns "" instead.
const WRY_055 = `    fun getCookies(url: String): String {
        val cookieManager = CookieManager.getInstance()
        return cookieManager.getCookie(url)
    }
`

test('every wry glue class is kept whole, not as an allowlist of methods', () => {
  const rules = jniKeepRules('app.bilimusic.mobile')
  for (const name of WRY_GLUE_CLASSES) {
    assert.match(rules, new RegExp(`^-keep class app\\.bilimusic\\.mobile\\.${name} \\{ \\*; \\}$`, 'm'))
  }
  // wry's own proguard file lists methods, so a wry upgrade that adds a JNI method
  // silently lost it again; the whole class must stay.
  assert.match(rules, /^-keep class app\.bilimusic\.mobile\.RustWebView \{ \*; \}$/m)
  assert.ok(!rules.includes('void getCookies'))
})

test('the keep file is generated for the packaged identifier', () => {
  const rules = jniKeepRules('com.example.app', ['RustWebView'])
  assert.match(rules, /^-keep class com\.example\.app\.RustWebView \{ \*; \}$/m)
  assert.match(rules, /^# THIS FILE IS AUTO-GENERATED\. DO NOT MODIFY!!$/m)
  assert.ok(!rules.includes('app.bilimusic.mobile'))
})

test('an empty cookie lookup falls back to an empty string', () => {
  const patched = patchEmptyCookies(WRY_055)
  assert.match(patched, /return cookieManager\.getCookie\(url\) \?: ""/)
  assert.equal(patchEmptyCookies(patched), patched)
})

test('a glue file that no longer matches is rejected instead of patched blindly', () => {
  assert.throws(() => patchEmptyCookies('fun getCookies(url: String) = ""'), /RustWebView\.getCookies/)
})

test('a missing glue file is left for the Gradle hook instead of failing the build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bilimusic-glue-'))
  const file = join(dir, 'RustWebView.kt')
  try {
    // `tauri android init` runs before wry writes the glue during the Rust build.
    assert.equal(await patchRustWebViewFile(file), false)
    await assert.rejects(patchRustWebViewFile(file, { required: true }), { code: 'ENOENT' })
    await writeFile(file, WRY_055)
    assert.equal(await patchRustWebViewFile(file), true)
    assert.match(await readFile(file, 'utf8'), /getCookie\(url\) \?: ""/)
    assert.equal(await patchRustWebViewFile(file), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
