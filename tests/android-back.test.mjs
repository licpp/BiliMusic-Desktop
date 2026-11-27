// Android 16 (API 36) stops calling `Activity.onBackPressed` and stops handing
// KEYCODE_BACK to the activity, so back only reaches the platform's
// OnBackInvokedCallback -- and only when the manifest opts in. TauriActivity
// leaves wry's handler off, so without this the embedded login page cannot be
// left with BACK: the press falls through to the system and the task goes home.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { editionManifest } from '../scripts/android-manifest.mjs'

// Checkouts on Windows use CRLF; these assertions are about the code, not the
// line endings.
const read = async path => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n')

test('both activities own the single WebView back navigation', async () => {
  for (const [path, label] of [
    ['src-tauri/android/phone/MainActivity.kt', 'phone'],
    ['src-tauri/android/large-screen/MainActivity.kt', 'car'],
  ]) {
    const activity = await read(path)
    // The platform callback is the only path that still receives back on
    // Android 16; the overlay priority keeps it away from androidx's bridge,
    // which registers later at the default priority.
    assert.match(
      activity,
      /onBackInvokedDispatcher\.registerOnBackInvokedCallback\(\s*OnBackInvokedDispatcher\.PRIORITY_OVERLAY,\s*\)/,
      label,
    )
    // Older devices still deliver back through the androidx dispatcher.
    assert.match(
      activity,
      /onBackPressedDispatcher\.addCallback\(this, object : OnBackPressedCallback\(true\)/,
      label,
    )
    // Back inside the WebView steps through its history; only the last entry
    // leaves the app, and the task keeps its state as the system did before.
    assert.match(
      activity,
      /if \(webView != null && webView\.canGoBack\(\)\) webView\.goBack\(\) else moveTaskToBack\(true\)/,
      label,
    )
    // wry's handler is off in TauriActivity; switching it back on would hand
    // the press to a callback that never received this WebView.
    assert.doesNotMatch(activity, /handleBackNavigation = true/, label)
  }
})

test('the manifest opts into the platform back callback', () => {
  const manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".MainActivity"/></application></manifest>'
  for (const large of [false, true]) {
    assert.match(editionManifest(manifest, large), /<application\b[^>]*android:enableOnBackInvokedCallback="true"/, `${large ? 'car' : 'phone'}`)
  }
  // The prepare step runs again on an existing project, and a duplicated
  // attribute makes the manifest merger fail.
  const twice = editionManifest(editionManifest(manifest))
  assert.equal(twice.match(/android:enableOnBackInvokedCallback/g)?.length, 1)
})

test('the generated project keeps the phone activity', async () => {
  // `src-tauri/gen` is ignored, so the activity only survives a regenerated
  // project through the prepare step.
  const prepare = await read('scripts/android-prepare.mjs')
  assert.match(prepare, /src-tauri\/android\/phone\/MainActivity\.kt/)
  assert.match(prepare, /java\/app\/bilimusic\/mobile\/MainActivity\.kt/)
})
