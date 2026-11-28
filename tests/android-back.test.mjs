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
    // Older devices still deliver back to `onBackPressed`, and the app plugin's
    // dispatcher callback -- registered after this activity -- would be reached
    // first, so the override is the only place the login page can be seen.
    assert.match(activity, /override fun onBackPressed\(\) = back\(\)/, label)
    // The app page is remembered from the WebView's own first URL, because the
    // embedded login can replace the app entry in the back/forward list and
    // `canGoBack()` then reports nothing to go back to.
    assert.match(activity, /private fun rememberHome\(webView: WebView, attempt: Int\)/, label)
    assert.match(activity, /webView\.postDelayed\(\{ rememberHome\(webView, attempt \+ 1\) \}, 100\)/, label)
    assert.match(activity, /override fun onWebViewCreate\(webView: WebView\) \{[\s\S]*?rememberHome\(webView, 0\)/, label)
    // Back on the login page reloads the app page, without going through the
    // WebView history that the login replaced.
    assert.match(activity, /!sameOrigin\(webView\.url, home\)/, label)
    assert.match(activity, /webView\.loadUrl\(home\)/, label)
    // On the app page back is not ours to decide: the player plugin hands it to
    // the page, which closes dialogs, full screen and the queue first. Replacing
    // that chain with a direct `moveTaskToBack` made every in-app back press
    // leave the app.
    assert.match(activity, /onBackPressedDispatcher\.hasEnabledCallbacks\(\)/, label)
    assert.match(activity, /onBackPressedDispatcher\.onBackPressed\(\)/, label)
    // wry's handler is off in TauriActivity; switching it back on would hand
    // the press to a callback that never received this WebView.
    assert.doesNotMatch(activity, /handleBackNavigation = true/, label)
  }
})

test('the app page still decides what back does', async () => {
  // The activities pass an app-page press to the androidx dispatcher, whose
  // callback belongs to the player plugin: it asks the page over
  // `bilimusic-back`, and only an unhandled press sends the task to the
  // background. Losing either end would make dialogs, full screen and the queue
  // stop closing on back.
  const plugin = await read('native/android-player/android/src/main/java/PlayerPlugin.kt')
  assert.match(plugin, /owner\?\.onBackPressedDispatcher\?\.addCallback\(/)
  assert.match(plugin, /window\.dispatchEvent\(new Event\('bilimusic-back'/, 'the plugin asks the page before leaving')
  const app = await read('src/app/App.tsx')
  assert.match(app, /addEventListener\('bilimusic-back'/, 'the app handles the press in its own chain')
  const car = await read('src/large-screen/focus.ts')
  assert.match(car, /bilimusic-back/, 'the car edition shares the same chain')
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

test('the generated project keeps each edition’s own activity', async () => {
  // `src-tauri/gen` is ignored, so the activity only survives a regenerated
  // project through the prepare step.
  const prepare = await read('scripts/android-prepare.mjs')
  // The phone activity is copied for the phone edition only: the car edition
  // copies its own file below, into its own package.
  assert.match(
    prepare,
    /if \(!largeScreen\) \{\s*await cp\(new URL\('\.\.\/src-tauri\/android\/phone\/MainActivity\.kt', import\.meta\.url\), new URL\('java\/app\/bilimusic\/mobile\/MainActivity\.kt', base\)\)\s*\}/,
  )
})
