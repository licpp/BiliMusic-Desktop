// The Android embedded login reuses the app's only webview, so its cookie jar
// outlives every attempt: re-adding a NetEase source after a previous login
// reopened the page already signed in, the account call passed, and the app
// closed the page the user had just opened. wry cannot delete a cookie on
// Android (`delete_cookie` is a no-op there) and `clear_all_browsing_data`
// leaves cookies alone, so the reset is native code. These tests pin the parts
// that keep it safe: the scope (never the Bilibili login in the same jar), the
// API-33 guard, and both ends of the login command.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Checkouts on Windows use CRLF; these assertions are about the code, not the
// line endings.
const read = async path => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

const KOTLIN_SESSION = 'native/android-player/android/src/main/java/NeteaseWebSession.kt'
const KOTLIN_PLUGIN = 'native/android-player/android/src/main/java/PlayerPlugin.kt'
const PLUGIN_RUST = 'native/android-player/src/lib.rs'
const LOGIN = 'src-tauri/src/interface/recommendation.rs'

test('the reset deletes the NetEase cookies and nothing else', async () => {
  const session = await read(KOTLIN_SESSION)
  assert.match(session, /CookieManager\.getInstance\(\)/)
  assert.ok(
    session.includes('manager.setCookie(ORIGIN, "$name=; Max-Age=0; Path=/; Domain=$domain")'),
    'each cookie is expired under every domain form it can be stored with',
  )
  // A cookie key is its name plus its domain, and getCookie does not report
  // the domain, so one deletion candidate per form is what removes it.
  const domains = /DOMAINS = listOf\(([^)]*)\)/.exec(session)?.[1] ?? ''
  const entries = [...domains.matchAll(/"([^"]+)"/g)].map(match => match[1])
  assert.ok(entries.length > 0, 'the deletion needs domain forms')
  for (const domain of entries) {
    assert.match(domain, /^\.?(music\.)?163\.com$/, `unexpected deletion scope: ${domain}`)
  }
  // The same jar holds the Bilibili login; wiping it would sign both out.
  assert.doesNotMatch(session, /removeAllCookies|deleteAllData/)
  assert.doesNotMatch(session, /"[^"]*bilibili/i, 'no other origin may be cleared')
  // The jar also carries the values; they must not be kept or reported.
  assert.match(session, /substringBefore\('='\)/)
  // The page's cached account state is only reachable per origin, and only
  // from API 33; older devices still get the cookie reset.
  assert.match(session, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.TIRAMISU/)
  assert.match(session, /WebStorage\.getInstance\(\)\.deleteOrigin\("https:\/\/music\.163\.com"\)/)
  assert.match(session, /manager\.flush\(\)/, 'the deletion has to reach the persisted store')
})

test('the native command reports counts, never cookie values', async () => {
  const plugin = await read(KOTLIN_PLUGIN)
  assert.match(plugin, /@Command\n    fun clear_netease_web_data\(invoke: Invoke\)/)
  assert.match(plugin, /NeteaseWebSession\.clear\(\)/)
  assert.ok(
    plugin.includes('.put("removed", report.removed.size)') && plugin.includes('.put("remaining", report.remaining.size)'),
    'the login log gets how much was removed, not what it was',
  )
  assert.match(plugin, /activity\.runOnUiThread \{\n            try \{\n                val report = NeteaseWebSession\.clear\(\)/)

  const rust = await read(PLUGIN_RUST)
  assert.match(rust, /pub async fn clear_netease_web_data<R: Runtime>\(/)
  assert.match(rust, /run_mobile_plugin_async\("clear_netease_web_data", serde_json::json!\(\{\}\)\)/)
})

test('the Android login resets before the page opens and after it closes', async () => {
  const login = await read(LOGIN)
  const androidStart = login.indexOf(
    '#[cfg(target_os = "android")]\n#[tauri::command]\npub async fn netease_web_login',
  )
  assert.ok(androidStart > 0, 'the Android login command is gone')
  const androidEnd = login.indexOf('pub fn netease_web_login_outcome')
  assert.ok(androidEnd > androidStart)
  const android = login.slice(androidStart, androidEnd)
  // Welcome back: the jar is read before the reset so the value that survived
  // it can be ignored, and then checked again to log a reset that did not work.
  const baseline = android.indexOf('let mut baseline_music_u = stored_music_u(&window, &cookie_url);')
  const reset = android.indexOf('reset_netease_web_session(&app).await')
  const survived = android.indexOf('if let Some(survivor) = stored_music_u(&window, &cookie_url) {')
  const navigate = android.indexOf('.navigate(login_url)')
  assert.ok(baseline > 0 && reset > baseline, 'read the jar, then clear it')
  assert.ok(survived > reset, 'check what the reset left behind')
  assert.ok(navigate > survived, 'the page opens only after the reset')
  // The account call still authenticates an old session, so the acceptance
  // check has to ignore the value the page started with.
  assert.match(
    android,
    /fresh_login_credentials\(&cookies, baseline_music_u\.as_deref\(\)\)/,
    'an old session must not be accepted as this login',
  )
  // Cancelled and timed-out attempts take the same way out, so the session the
  // backend did not persist must not stay in the jar either.
  const restore = android.indexOf('restore_app_page(&window, &app_url).await')
  const after = android.indexOf('reset_netease_web_session(&app).await', reset + 1)
  assert.ok(restore > 0 && after > restore, 'the page is restored before the jar is cleared again')

  // The desktop path opens an incognito window, whose cookies die with it.
  const desktopStart = login.indexOf(
    '#[cfg(desktop)]\n#[tauri::command]\npub async fn netease_web_login',
  )
  assert.ok(desktopStart > 0)
  const desktop = login.slice(desktopStart, androidStart)
  assert.doesNotMatch(desktop, /reset_netease_web_session|fresh_login_credentials/)
  assert.match(desktop, /\.incognito\(true\)/)
})

test('an old value and a real login are told apart by the value itself', async () => {
  // The Rust unit test covers the filter; this pins the helper it calls so a
  // rename cannot silently turn the check back into plain login_credentials.
  const login = await read(LOGIN)
  assert.match(login, /fn fresh_login_credentials\(/)
  assert.match(
    login,
    /login_credentials\(cookies\)\s*\.filter\(\|\(music_u, _\)\| baseline_music_u != Some\(music_u\.as_str\(\)\)\)/,
  )
})
