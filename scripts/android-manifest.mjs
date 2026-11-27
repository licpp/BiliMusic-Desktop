// Used by both editions and unit-tested without an SDK or generated project.
export function editionManifest(xml, large = false) {
  xml = xml.replace(/\s*<uses-feature\b[^>]*android:name="(?:android\.software\.leanback|android\.hardware\.touchscreen)"[^>]*\/>/g, '')
    .replace(/\s*<category\s+android:name="android\.intent\.category\.LEANBACK_LAUNCHER"\s*\/>/g, '')
    .replace(/\s*<uses-permission\b(?=[^>]*android:name="android.permission.SYSTEM_ALERT_WINDOW")(?=[^>]*tools:node="remove")[^>]*\/>/g, '')
  // Android 16 (API 36) no longer calls `Activity.onBackPressed` and no longer
  // delivers KEYCODE_BACK to the activity for back, so back only reaches the
  // platform's OnBackInvokedCallback -- and the platform ignores that API unless
  // the app opts in here. Without it BACK leaves the app instead of stepping
  // back inside the single WebView (out of the embedded login page). The
  // attribute is replaced rather than added, so re-running the prepare step on
  // an existing project does not duplicate it.
  xml = xml.replace(/\s*android:enableOnBackInvokedCallback="[^"]*"/g, '')
    .replace(/<application\b/, '<application android:enableOnBackInvokedCallback="true"')
  if (!large) return xml
  if (!xml.includes('xmlns:tools=')) xml = xml.replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ')
  xml = xml.replace(/\s*<application/, '\n<uses-feature android:name="android.software.leanback" android:required="false" />\n<uses-feature android:name="android.hardware.touchscreen" android:required="false" />\n<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" tools:node="remove" />\n<application')
  xml = xml.replace(/<application\b[^>]*>/, tag => tag.replace(/\s+android:banner="[^"]*"/g, '').replace('<application', '<application android:banner="@drawable/tv_banner"'))
  xml = xml.replace(/<activity\b[^>]*>/g, tag => /android:name="[^"]*MainActivity"/.test(tag) ? tag.replace(/\s+android:screenOrientation="[^"]*"/g, '').replace('<activity', '<activity android:screenOrientation="sensorLandscape"') : tag)
  xml = xml.replace(/(<category\s+android:name="android\.intent\.category\.LAUNCHER"\s*\/>)/, '$1\n<category android:name="android.intent.category.LEANBACK_LAUNCHER" />')
  if (!xml.includes('android:name=".CarPlayerActivity"')) {
    // Keep the existing launcher component and move WebView creation behind it.
    const main = xml.match(/<activity\b[^>]*android:name="[^"]*MainActivity"[^>]*>/)?.[0]
    if (!main) throw new Error('Missing Android MainActivity')
    const player = main
      .replace(/android:name="[^"]*MainActivity"/, 'android:name=".CarPlayerActivity"')
      .replace(/\s+android:exported="[^"]*"/, '')
      .replace(/>$/, ' android:exported="false" />')
    xml = xml.replace('</application>', `    ${player}\n    </application>`)
  }
  return xml
}
