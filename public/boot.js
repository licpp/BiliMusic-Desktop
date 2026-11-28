// Paint the stored theme before the module loads. Keep this in sync with
// src/domain/theme.ts: anything that is not light/dark/system is dark, and a
// `system` preference resolves through the media query when the WebView has one.
try {
  var preference = localStorage.getItem('bilimusic-theme')
  var theme = preference === 'light' ? 'light' : 'dark'
  if (preference === 'system' && typeof window.matchMedia === 'function') {
    var scheme = window.matchMedia('(prefers-color-scheme: dark)')
    if (scheme.media !== 'not all') theme = scheme.matches ? 'dark' : 'light'
  }
  document.documentElement.dataset.theme = theme
} catch (_) {}

document.addEventListener('DOMContentLoaded', function () {
  var entry = document.querySelector('meta[name="bilimusic-android-entry"]')
  if (!entry) return
  var chromium = /(?:^|\s)Chrome\/(\d+)\./.exec(navigator.userAgent)
  if (chromium && Number(chromium[1]) >= 91) {
    var script = document.createElement('script')
    script.type = 'module'
    script.crossOrigin = 'anonymous'
    script.src = entry.content
    document.head.appendChild(script)
  } else {
    var splash = document.getElementById('app-bootstrap')
    splash.removeAttribute('aria-label')
    splash.setAttribute('data-webview-upgrade', '')
    document.getElementById('app-webview-upgrade').hidden = false
  }
})
