package app.bilimusic.large

import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
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
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }
}
