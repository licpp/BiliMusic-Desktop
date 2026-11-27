package app.bilimusic.large

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.window.OnBackInvokedDispatcher
import androidx.activity.OnBackPressedCallback
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
        } else {
            onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() = back()
            })
        }
    }

    override fun onWebViewCreate(webView: WebView) {
        this.webView = webView
    }

    // TauriActivity turns wry's back handling off; this is the only back path.
    private fun back() {
        val webView = webView
        if (webView != null && webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
    }
}
