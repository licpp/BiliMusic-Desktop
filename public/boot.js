try { document.documentElement.dataset.theme = localStorage.getItem('bilimusic-theme') === 'light' ? 'light' : 'dark' } catch (_) {}

document.addEventListener('DOMContentLoaded', function () {
  var entry = document.querySelector('meta[name="bilimusic-android-entry"]')
  if (!entry) return
  // :has() is part of the standard UI's Chromium 105 capability baseline.
  if (window.CSS && CSS.supports('selector(:has(*))')) {
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
