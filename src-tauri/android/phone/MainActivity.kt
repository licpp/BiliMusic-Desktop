package app.bilimusic.mobile

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
  }

  // TauriActivity leaves wry's own handling off, so this is the only back path.
  // Leaving the app on the last entry matches what the system did before the
  // activity handled back: the task goes to the background with its state.
  private fun back() {
    val webView = webView
    if (webView != null && webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
  }
}
