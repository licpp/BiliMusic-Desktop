package app.bilimusic.mobile

import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.window.OnBackInvokedDispatcher
import androidx.activity.enableEdgeToEdge

// The app targets API 36, where Android 16 stops calling `Activity.onBackPressed`
// and stops handing KEYCODE_BACK to the activity for back: back only reaches the
// platform's OnBackInvokedCallback (opted in through `enableOnBackInvokedCallback`
// in scripts/android-manifest.mjs). The single WebView has to own that callback,
// or BACK on a page the app navigated into -- the embedded NetEase login -- leaves
// the app instead of going back inside it.
class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  /** The app's own page: the first page this WebView commits. */
  private var homeUrl: String? = null
  /** Set while the press is being passed on, so it cannot come back here. */
  private var chaining = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      // androidx bridges its dispatcher to this same platform callback at the
      // default priority once the app plugin starts, after this activity, and the
      // later registration of an equal priority takes the press first. The
      // overlay priority keeps back here, where the WebView is.
      onBackInvokedDispatcher.registerOnBackInvokedCallback(
        OnBackInvokedDispatcher.PRIORITY_OVERLAY,
      ) { back() }
    }
  }

  // Below API 33 the framework calls `onBackPressed` itself, and androidx's
  // dispatcher runs its callbacks last-in-first-out: the app plugin registers
  // its own after this activity, so a callback added to the dispatcher here
  // would never run. Coming in through the override keeps the login page ahead
  // of that chain; everything else is passed on to it.
  @Suppress("MissingSuperCall")
  override fun onBackPressed() = back()

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    rememberHome(webView, 0)
  }

  // The WebView exists before it has loaded anything, so its URL arrives a
  // moment later. The first page it commits is the app itself -- the embedded
  // login can only start once the app is interactive -- so that URL is the one
  // back has to return to. A slow first start is not a reason to stop looking:
  // without a home the login page press would fall back to the app's chain,
  // which has no app page to go back to and sends the task to the background.
  private fun rememberHome(webView: WebView, attempt: Int) {
    if (homeUrl != null) return
    val url = webView.url
    if (url != null && url != "about:blank" && !url.startsWith("chrome-error")) {
      homeUrl = url
      return
    }
    val delay = if (attempt < 20) 100L else 1000L
    webView.postDelayed({ rememberHome(webView, attempt + 1) }, delay)
  }

  /** Same page for our purposes: the app is served from one origin. */
  private fun sameOrigin(a: String?, b: String?): Boolean {
    if (a == null || b == null) return false
    val left = Uri.parse(a)
    val right = Uri.parse(b)
    return left.scheme == right.scheme && left.authority == right.authority
  }

  // TauriActivity leaves wry's own handling off, so this is the only back path.
  //
  // Anywhere but the app page -- the embedded login -- back reloads the app page.
  // That deliberately does not use `goBack()`: when the login replaced the app
  // page in the WebView's back/forward list (`canGoBack()` false, the list held
  // only the login) the press went straight to the launcher. The reload is also
  // how the login ends: the Rust loop sees the URL leave the login page, stops
  // the attempt as a cancel and leaves its outcome for the reloaded page, which
  // reopens the dialog that started the login.
  //
  // On the app page the app already decides what back does: the player plugin
  // hands the press to the page, which closes dialogs, full screen, lyrics and
  // the queue, and otherwise asks for the task to go to the background. This
  // callback runs before androidx's bridge to the same dispatcher, so the press
  // is passed on rather than replaced, or those pages would stop responding.
  private fun back() {
    val webView = webView
    val home = homeUrl
    if (webView != null && home != null && !sameOrigin(webView.url, home)) {
      webView.loadUrl(home)
      return
    }
    if (chaining || !onBackPressedDispatcher.hasEnabledCallbacks()) {
      moveTaskToBack(true)
      return
    }
    chaining = true
    try {
      onBackPressedDispatcher.onBackPressed()
    } finally {
      chaining = false
    }
  }
}
