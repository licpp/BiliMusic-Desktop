package app.bilimusic.mobile

import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.window.OnBackInvokedDispatcher
import androidx.activity.OnBackPressedCallback
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
    } else {
      onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() = back()
      })
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    rememberHome(webView, 0)
  }

  // The WebView exists before it has loaded anything, so its URL arrives a
  // moment later. The first page it commits is the app itself -- the embedded
  // login can only start once the app is interactive -- so that URL is the one
  // back has to return to.
  private fun rememberHome(webView: WebView, attempt: Int) {
    if (homeUrl != null || attempt > 40) return
    val url = webView.url
    if (url != null && url != "about:blank" && !url.startsWith("chrome-error")) {
      homeUrl = url
      return
    }
    webView.postDelayed({ rememberHome(webView, attempt + 1) }, 100)
  }

  /** Same page for our purposes: the app is served from one origin. */
  private fun sameOrigin(a: String?, b: String?): Boolean {
    if (a == null || b == null) return false
    val left = Uri.parse(a)
    val right = Uri.parse(b)
    return left.scheme == right.scheme && left.authority == right.authority
  }

  // TauriActivity leaves wry's own handling off, so this is the only back path.
  // On the app page it leaves the app, as the system did before the activity
  // handled back: the task goes to the background with its state.
  //
  // Anywhere else -- the embedded login -- it reloads the app page instead. That
  // deliberately does not use `goBack()`: when the login replaced the app page in
  // the WebView's back/forward list (`canGoBack()` false, the list held only the
  // login) the press went straight to the launcher. The reload is also how the
  // login ends: the Rust loop sees the URL leave the login page, stops the
  // attempt as a cancel and leaves its outcome for the reloaded page, which
  // reopens the dialog that started the login.
  private fun back() {
    val webView = webView
    if (webView == null) {
      moveTaskToBack(true)
      return
    }
    val home = homeUrl
    if (home == null) {
      if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
      return
    }
    if (sameOrigin(webView.url, home)) moveTaskToBack(true) else webView.loadUrl(home)
  }
}
