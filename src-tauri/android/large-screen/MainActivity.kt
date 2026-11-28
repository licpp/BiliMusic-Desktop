package app.bilimusic.large

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.window.OnBackInvokedDispatcher
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

private const val MIN_WEBVIEW_MAJOR = 66

// TauriActivity starts the WebView during onCreate. Keep the launcher native so
// the warning can appear even when the installed WebView cannot run the app.
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val version = runCatching { WebView.getCurrentWebViewPackage()?.versionName }.getOrNull()
        val major = version?.trim()?.substringBefore('.')?.toIntOrNull()
        if (major != null && major < MIN_WEBVIEW_MAJOR) {
            AlertDialog.Builder(this)
                .setTitle(R.string.car_webview_upgrade_title)
                .setMessage(getString(R.string.car_webview_upgrade_message, version, MIN_WEBVIEW_MAJOR))
                .setPositiveButton(R.string.car_webview_upgrade_close) { _, _ -> finish() }
                .setOnCancelListener { finish() }
                .show()
            return
        }

        startActivity(Intent(this, CarPlayerActivity::class.java))
        finish()
    }
}

class CarPlayerActivity : TauriActivity() {
    private var webView: WebView? = null
    /** The app's own page: the first page this WebView commits. */
    private var homeUrl: String? = null
    /** Set while the press is being passed on, so it cannot come back here. */
    private var chaining = false

    // The app targets API 36, where Android 16 stops calling
    // `Activity.onBackPressed` and stops handing KEYCODE_BACK to the activity
    // for back: back only reaches the platform's OnBackInvokedCallback. The
    // single WebView needs its own handling, because the embedded login
    // replaces the app page there and BACK must walk back out of it instead of
    // leaving the player.
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // The same reason as the phone activity: androidx bridges the
            // dispatcher to this platform callback at the default priority,
            // after this activity, and an equal-priority registration made
            // later takes the press first.
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_OVERLAY,
            ) { back() }
        }
    }

    // Below API 33 the framework calls `onBackPressed` itself, and the app
    // plugin's dispatcher callback -- registered after this activity -- is
    // reached first, so this override is where the login page is handled.
    // Everything else is passed on to the chain.
    @Suppress("MissingSuperCall")
    override fun onBackPressed() = back()

    override fun onWebViewCreate(webView: WebView) {
        this.webView = webView
        rememberHome(webView, 0)
    }

    // The WebView exists before it has loaded anything, so its URL arrives a
    // moment later. The first page it commits is the app itself, as on the
    // phone; a slow first start keeps the search going, because a missing home
    // leaves the login page press on the app's chain, which sends the player to
    // the background instead of back to its own page.
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

    // TauriActivity turns wry's back handling off; this is the only back path.
    // Anywhere but the app page -- the embedded login -- back reloads the app
    // page, because the login can replace the app entry in the WebView's
    // back/forward list and `goBack()` then does nothing. The Rust login loop
    // sees the URL change and ends the attempt as a cancel.
    //
    // On the app page the app already decides what back does: the player plugin
    // hands the press to the page, which closes dialogs, full screen, lyrics and
    // the queue, and otherwise asks for the task to go to the background. This
    // callback runs before androidx's bridge to the same dispatcher, so the
    // press is passed on rather than replaced, or those pages would stop
    // responding.
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
