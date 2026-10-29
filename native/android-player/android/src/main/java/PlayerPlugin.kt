package app.bilimusic.player

import android.app.Activity
import android.content.Intent
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class PlayArgs {
    lateinit var url: String
    lateinit var id: String
    var title: String = "BiliMusic"
    var artist: String = "歌手未知"
    var position: Double = 0.0
    var volume: Double = 0.7
}
@InvokeArg
class ControlArgs {
    lateinit var action: String
    var value: Double = 0.0
    var id: String = ""
    var title: String = "BiliMusic"
    var artist: String = "歌手未知"
}

@InvokeArg
class SecretArgs {
    lateinit var key: String
    var value: String? = null
    var remove: Boolean = false
}

@TauriPlugin
class PlayerPlugin(private val activity: Activity) : Plugin(activity) {
    // Called only by Rust; no frontend ACL permission is granted for this command.
    @Command
    fun secret(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecretArgs::class.java)
            require(args.key.matches(Regex("sync-[0-9]+-(cloud|webdav)")))
            val prefs = activity.getSharedPreferences("bilimusic-sync-secrets", Activity.MODE_PRIVATE)
            val store = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val alias = "bilimusic-sync-v1"
            if (!store.containsAlias(alias)) {
                val generator = javax.crypto.KeyGenerator.getInstance("AES", "AndroidKeyStore")
                generator.init(android.security.keystore.KeyGenParameterSpec.Builder(alias,
                    android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE).build())
                generator.generateKey()
            }
            val key = store.getKey(alias, null) as javax.crypto.SecretKey
            if (args.remove) { check(prefs.edit().remove(args.key).commit()) }
            else if (args.value != null) {
                val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, key)
                val bytes = cipher.iv + cipher.doFinal(args.value!!.toByteArray(Charsets.UTF_8))
                check(prefs.edit().putString(args.key, android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)).commit())
            }
            val result = JSObject()
            val encoded = prefs.getString(args.key, null)
            if (encoded != null) {
                val bytes = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP)
                val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(javax.crypto.Cipher.DECRYPT_MODE, key, javax.crypto.spec.GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                result.put("value", String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
            }
            invoke.resolve(result)
        } catch (_: Exception) { invoke.reject("无法访问同步安全存储，请重新连接") }
    }
    private var immersive = false
    private var managedWebView: WebView? = null

    @Suppress("DEPRECATION")
    private fun updateSystemBars() {
        activity.window.statusBarColor = android.graphics.Color.TRANSPARENT
        activity.window.navigationBarColor = android.graphics.Color.TRANSPARENT
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            activity.window.isStatusBarContrastEnforced = !immersive
            activity.window.isNavigationBarContrastEnforced = !immersive
        }
    }

    override fun load(webView: WebView) {
        managedWebView = webView
        // Own system-bar/IME insets, including Android 15+ enforced edge-to-edge.
        // Resize the actual WebView instead of guessing CSS safe areas on Android.
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() or androidx.core.view.WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())
            val params = view.layoutParams as? android.view.ViewGroup.MarginLayoutParams
            val left = if (immersive) 0 else bars.left
            val top = if (immersive) 0 else bars.top
            val right = if (immersive) 0 else bars.right
            val bottom = if (immersive) keyboard.bottom else maxOf(bars.bottom, keyboard.bottom)
            params?.let {
                if (it.leftMargin != left || it.topMargin != top || it.rightMargin != right || it.bottomMargin != bottom) {
                    it.setMargins(left, top, right, bottom)
                    view.layoutParams = it
                }
            }
            val density = activity.resources.displayMetrics.density
            val safeTop = if (immersive) bars.top / density else 0f
            val safeBottom = if (immersive && keyboard.bottom == 0) bars.bottom / density else 0f
            val safeLeft = if (immersive) bars.left / density else 0f
            val safeRight = if (immersive) bars.right / density else 0f
            webView.evaluateJavascript("document.documentElement.style.setProperty('--native-safe-top','${safeTop}px');" +
                "document.documentElement.style.setProperty('--native-safe-bottom','${safeBottom}px');" +
                "document.documentElement.style.setProperty('--native-safe-left','${safeLeft}px');" +
                "document.documentElement.style.setProperty('--native-safe-right','${safeRight}px');", null)
            insets
        }
        androidx.core.view.ViewCompat.requestApplyInsets(webView)
        webView.settings.mediaPlaybackRequiresUserGesture = false
        // CSP and the network security config limit HTTP media to loopback.
        webView.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        val owner = activity as? androidx.appcompat.app.AppCompatActivity
        owner?.onBackPressedDispatcher?.addCallback(
            owner, object : androidx.activity.OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    webView.evaluateJavascript("window.dispatchEvent(new Event('bilimusic-back', {cancelable:true}))") { result ->
                        if (result == "true") activity.moveTaskToBack(true)
                    }
                }
            })
        PlaybackService.listener = { event -> trigger("state", event) }
    }
    // Match the snake_case commands used by the current Tauri JS SDK. The inherited
    // camelCase methods alone are not declared in this plugin's generated ACL.
    @Command
    fun register_listener(invoke: Invoke) { super.registerListener(invoke) }
    @Command
    fun remove_listener(invoke: Invoke) { super.removeListener(invoke) }

    @Command
    fun play(invoke: Invoke) {
        val args = invoke.parseArgs(PlayArgs::class.java)
        // Media URLs must be produced by our Rust proxy, never arbitrary file/network URLs.
        val uri = android.net.Uri.parse(args.url)
        if (uri.scheme != "http" || uri.host != "127.0.0.1") {
            invoke.reject("无效的本地播放地址"); return
        }
        val intent = Intent(activity, PlaybackService::class.java).setAction("load")
            .putExtra("url", args.url).putExtra("id", args.id)
            .putExtra("title", args.title).putExtra("artist", args.artist)
            .putExtra("position", args.position).putExtra("volume", args.volume)
        activity.startForegroundService(intent)
        invoke.resolve()
    }
    @Command
    fun control(invoke: Invoke) {
        val args = invoke.parseArgs(ControlArgs::class.java)
        activity.runOnUiThread {
            if (args.action == "prepare") {
                // Establish foreground ownership before Rust resolves the URL, so switching
                // tracks still works after the activity goes into the background.
                activity.startForegroundService(Intent(activity, PlaybackService::class.java)
                    .setAction("prepare").putExtra("id", args.id)
                    .putExtra("title", args.title).putExtra("artist", args.artist))
            } else if (args.action == "immersive") {
                immersive = args.value > 0
                updateSystemBars()
                managedWebView?.let { androidx.core.view.ViewCompat.requestApplyInsets(it) }
            } else if (args.action == "theme") {
                val light = args.value > 0
                val controller = androidx.core.view.WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                controller.isAppearanceLightStatusBars = light
                controller.isAppearanceLightNavigationBars = light
                updateSystemBars()
                activity.window.decorView.setBackgroundColor(android.graphics.Color.parseColor(if (light) "#f4f6fa" else "#071019"))
            } else PlaybackService.instance?.control(args.action, args.value)
            invoke.resolve()
        }
    }
    @Command
    fun snapshot(invoke: Invoke) {
        activity.runOnUiThread { invoke.resolve(PlaybackService.instance?.snapshot() ?: JSObject()) }
    }
}
