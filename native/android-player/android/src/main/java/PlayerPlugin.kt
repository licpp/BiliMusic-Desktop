package app.bilimusic.player

import android.app.Activity
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Build
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.graphics.Insets
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class PlayArgs {
    lateinit var url: String
    lateinit var id: String
    var title: String = "BiliMusic"
    var artist: String = "歌手未知"
    var album: String? = null
    var durationSeconds: Double = 0.0
    var coverUrl: String? = null
    var position: Double = 0.0
    var loudnessGainDb: Double = 0.0
    var loudnessEnabled: Boolean = false
    var loudnessRevision: Long = 0
    var volume: Double = 1.0
    var playing: Boolean = true
    var seamless: Boolean = false
    var upgradeUrl: String? = null
    var rate: Double = 1.0
    var collectionRef: String? = null
    var automaticResume: AutomaticResumePolicy? = null
    var diagnosticId: String? = null
    var accountSession: String? = null
}
@InvokeArg
class LyricsArgs { var data: String = "{}" }
@InvokeArg
class ControlArgs {
    var settingsRevision: Long = 0
    lateinit var action: String
    var value: Double = 0.0
    var keepSystemInsets: Boolean = false
    var id: String = ""
    var collectionRef: String? = null
    var title: String = "BiliMusic"
    var artist: String = "歌手未知"
    var album: String? = null
    var durationSeconds: Double = 0.0
    var coverUrl: String? = null
}

internal fun playbackWindowMargins(bars: Insets, immersive: Boolean, keepSystemInsets: Boolean): Insets =
    when {
        // Reserve the tablet's top inset in CSS so its backdrop can continue
        // behind the status bar without resizing the WebView on open or close.
        keepSystemInsets -> Insets.of(bars.left, 0, bars.right, bars.bottom)
        immersive -> Insets.NONE
        else -> bars
    }

@InvokeArg
class SecretArgs {
    lateinit var key: String
    var value: String? = null
    var remove: Boolean = false
}

@InvokeArg
class ListeningArgs {
    lateinit var channel: Channel
    lateinit var profilePath: String
}
@InvokeArg
class ResolvedArgs { var request: Long = 0; var data: String = "{}" }

@InvokeArg
class DownloadPathArgs { lateinit var path: String; var skipExisting: Boolean = false }

@InvokeArg
class InstallUpdateArgs { lateinit var path: String; lateinit var version: String; var versionCode: Long? = null }

@TauriPlugin
class PlayerPlugin(private val activity: Activity) : Plugin(activity) {
    private val downloadStorage by lazy { DownloadStorage(activity.applicationContext) }
    private val downloadWorker = java.util.concurrent.Executors.newSingleThreadExecutor()
    private var playbackNotificationPermission: PlaybackNotificationPermission? = null

    // These storage commands are called by Rust only; they have no WebView ACL grant.
    @Command
    fun download_destination(invoke: Invoke) { invoke.resolve(downloadStorage.status()) }

    @Command
    fun choose_download_destination(invoke: Invoke) {
        activity.runOnUiThread {
            try { startActivityForResult(invoke, downloadStorage.pickerIntent(), "downloadDestinationChosen") }
            catch (_: Exception) { invoke.reject("无法打开系统文件夹选择器") }
        }
    }

    @ActivityCallback
    fun downloadDestinationChosen(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.resolve(downloadStorage.status().put("cancelled", true)); return
        }
        downloadWorker.execute {
            try {
                downloadStorage.select(uri, result.data?.flags ?: 0)
                invoke.resolve(downloadStorage.status())
            } catch (error: Exception) { invoke.reject(error.message ?: "无法使用这个文件夹，请重新选择") }
        }
    }

    @Command
    fun reset_download_destination(invoke: Invoke) {
        downloadWorker.execute {
            try { downloadStorage.reset(); invoke.resolve(downloadStorage.status()) }
            catch (_: Exception) { invoke.reject("无法恢复默认目录，请重新选择文件夹") }
        }
    }

    @Command
    fun save_download(invoke: Invoke) {
        val args = invoke.parseArgs(DownloadPathArgs::class.java)
        downloadWorker.execute {
            try {
                val saved = downloadStorage.save(args.path, args.skipExisting)
                if (args.skipExisting) invoke.resolve(JSObject().put("saved", saved)) else invoke.resolve()
            }
            catch (error: Exception) {
                invoke.reject(if (error is SecurityException) "保存文件夹的授权已失效，请在设置中重新选择下载目录"
                    else error.message ?: "保存失败，请检查文件夹权限与剩余空间")
            }
        }
    }

    // Rust-only: no frontend command permission is exposed.
    @Command
    fun install_update(invoke: Invoke) {
        val args = invoke.parseArgs(InstallUpdateArgs::class.java)
        downloadWorker.execute {
            try {
                val file = ApkUpdateInstaller.prepare(activity, args.path, args.version, args.versionCode)
                activity.runOnUiThread {
                    try { invoke.resolve(JSObject().put("status", ApkUpdateInstaller.launch(activity, file))) }
                    catch (_: Exception) { invoke.reject("无法打开系统安装器，请检查安装权限或前往官网下载") }
                }
            } catch (error: Exception) { invoke.reject(error.message ?: "安装包校验失败") }
        }
    }

    @Command
    fun lyrics(invoke: Invoke) {
        val args=invoke.parseArgs(LyricsArgs::class.java)
        activity.runOnUiThread {
            try { invoke.resolve(JSObject(FloatingLyricsOverlay.command(activity,args.data).toString())) }
            catch (_: Exception) { invoke.reject("无法显示悬浮歌词，请检查悬浮窗权限") }
        }
    }
    @Command
    fun diagnostic_environment(invoke: Invoke) {
        val webview = runCatching { WebView.getCurrentWebViewPackage() }.getOrNull()
        val model = listOf(Build.MANUFACTURER, Build.MODEL)
            .filter { it.isNotBlank() && it != Build.UNKNOWN }.distinct().joinToString(" ")
        val result = JSObject()
            .put("osVersion", Build.VERSION.RELEASE)
            .put("osBuild", Build.DISPLAY)
            .put("apiLevel", Build.VERSION.SDK_INT)
            .put("deviceModel", model)
            .put("webviewVersion", webview?.versionName)
            .put("webviewPackage", webview?.packageName)
        if (Build.VERSION.SDK_INT >= 30) {
            runCatching {
                val manager = activity.getSystemService(android.app.ActivityManager::class.java)
                val abnormal = manager?.getHistoricalProcessExitReasons(null, 0, 8)?.firstOrNull {
                    it.processName == activity.applicationInfo.processName && it.reason in setOf(
                        android.app.ApplicationExitInfo.REASON_CRASH,
                        android.app.ApplicationExitInfo.REASON_CRASH_NATIVE,
                        android.app.ApplicationExitInfo.REASON_ANR,
                        android.app.ApplicationExitInfo.REASON_LOW_MEMORY,
                        android.app.ApplicationExitInfo.REASON_INITIALIZATION_FAILURE,
                    )
                }
                if (abnormal != null) result.put("lastExitReason", abnormal.reason).put("lastExitAt", abnormal.timestamp)
            }
        }
        invoke.resolve(result)
    }

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
    // Registered from Rust directly; this command has no WebView ACL grant.
    @Command
    fun observe_listening(invoke: Invoke) {
        val args = invoke.parseArgs(ListeningArgs::class.java)
        PlaybackService.profilePath = args.profilePath
        PlaybackService.listeningListener = { event -> args.channel.send(event) }
        invoke.resolve()
    }
    // Registered by Rust directly; neither command is exposed to the WebView ACL.
    @Command
    fun observe_playback(invoke: Invoke) {
        val args = invoke.parseArgs(ListeningArgs::class.java)
        PlaybackService.profilePath = args.profilePath
        PlaybackService.resolveListener = { request, payload ->
            args.channel.send(JSObject().put("request", request).put("payload", payload))
        }
        invoke.resolve()
    }
    @Command
    fun resolved(invoke: Invoke) {
        val args = invoke.parseArgs(ResolvedArgs::class.java)
        activity.runOnUiThread {
            PlaybackService.instance?.resolved(args.request, org.json.JSONObject(args.data))
            invoke.resolve()
        }
    }
    @Command
    fun queue(invoke: Invoke) {
        val args = invoke.parseArgs(LyricsArgs::class.java)
        activity.runOnUiThread {
            try {
                // Validate even when no service has been started yet.
                NativeQueue().update(org.json.JSONObject(args.data))
                PlaybackService.queueData = args.data
                PlaybackService.instance?.updateQueue(args.data)
                invoke.resolve()
            } catch (_: Exception) { invoke.reject("无效的播放队列") }
        }
    }

    private var previousOrientation: Int? = null
    private var immersive = false
    private var keepSystemInsets = false
    private val drawsUnderSystemBars get() = immersive && !keepSystemInsets
    private val drawsUnderStatusBar get() = immersive || keepSystemInsets
    private var largeScreen = false

    private fun setVideoFullscreen(enabled: Boolean) {
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        if (enabled && previousOrientation == null) {
            previousOrientation = activity.requestedOrientation
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
            if (!largeScreen) activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else if (!enabled) {
            val original = previousOrientation ?: return
            previousOrientation = null
            activity.requestedOrientation = original
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }
    private var managedWebView: WebView? = null

    @Suppress("DEPRECATION")
    private fun updateSystemBars() {
        activity.window.statusBarColor = android.graphics.Color.TRANSPARENT
        activity.window.navigationBarColor = android.graphics.Color.TRANSPARENT
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            activity.window.isStatusBarContrastEnforced = !drawsUnderStatusBar
            activity.window.isNavigationBarContrastEnforced = !immersive
        }
    }

    override fun load(webView: WebView) {
        managedWebView = webView
        // Own system-bar/IME insets, including Android 15+ enforced edge-to-edge.
        // Keep layout stable; the IME covers the bottom of the WebView.
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        activity.window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() or androidx.core.view.WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())
            val params = view.layoutParams as? android.view.ViewGroup.MarginLayoutParams
            val margins = playbackWindowMargins(bars, immersive, keepSystemInsets)
            val left = margins.left
            val top = margins.top
            val right = margins.right
            val bottom = margins.bottom
            params?.let {
                if (it.leftMargin != left || it.topMargin != top || it.rightMargin != right || it.bottomMargin != bottom) {
                    it.setMargins(left, top, right, bottom)
                    view.layoutParams = it
                }
            }
            val density = activity.resources.displayMetrics.density
            val safeTop = (bars.top - top) / density
            val safeBottom = if (keyboard.bottom == 0) (bars.bottom - bottom) / density else 0f
            val safeLeft = (bars.left - left) / density
            val safeRight = (bars.right - right) / density
            val keyboardOverlap = (keyboard.bottom - bottom).coerceAtLeast(0) / density
            val layoutHeight = (view.rootView.height - top - bottom).coerceAtLeast(0) / density
            val tabletInsetAttribute = if (keepSystemInsets) "setAttribute('data-android-tablet-insets','')" else "removeAttribute('data-android-tablet-insets')"
            webView.evaluateJavascript("document.documentElement.$tabletInsetAttribute;" +
                "document.documentElement.style.setProperty('--native-layout-height','${layoutHeight}px');" +
                "document.documentElement.style.setProperty('--native-keyboard','${keyboardOverlap}px');" +
                "window.dispatchEvent(new Event('bilimusic-keyboard'));" +
                "document.documentElement.style.setProperty('--native-safe-top','${safeTop}px');" +
                "document.documentElement.style.setProperty('--native-safe-bottom','${safeBottom}px');" +
                "document.documentElement.style.setProperty('--native-safe-left','${safeLeft}px');" +
                "document.documentElement.style.setProperty('--native-safe-right','${safeRight}px');", null)
            insets
        }
        androidx.core.view.ViewCompat.requestApplyInsets(webView)
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.settings.setSupportZoom(false)
        webView.settings.builtInZoomControls = false
        webView.settings.displayZoomControls = false
        // CSP and the network security config limit HTTP media to loopback.
        webView.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        val owner = activity as? androidx.appcompat.app.AppCompatActivity
        if (owner != null && playbackNotificationPermission == null) {
            playbackNotificationPermission = PlaybackNotificationPermission(owner) {
                PlaybackService.instance?.refreshPlaybackNotification()
            }
        }
        owner?.onBackPressedDispatcher?.addCallback(
            owner, object : androidx.activity.OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    webView.evaluateJavascript("window.dispatchEvent(new Event('bilimusic-back', {cancelable:true}))") { result ->
                        if (result == "true") activity.moveTaskToBack(true)
                    }
                }
            })
        PlaybackService.listener = { event -> trigger("state", event) }
        PlaybackService.controllerListener = { controller -> activity.mediaController = controller }
        PlaybackService.instance?.attachController()
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
        if(args.seamless){
            activity.runOnUiThread { PlaybackService.instance?.configureLoudness(args.loudnessEnabled,args.loudnessRevision) }
            activity.runOnUiThread { val service=PlaybackService.instance;if(service==null)invoke.reject("当前没有可切换的音源") else service.switchSource(args.url,args.id,args.loudnessGainDb){message->if(message==null)invoke.resolve()else invoke.reject(message)} }
            return
        }
        val intent = Intent(activity, PlaybackService::class.java).setAction("load")
            .putExtra("url", args.url).putExtra("id", args.id).putExtra("diagnosticId", args.diagnosticId).putExtra("accountSession", args.accountSession)
            .putExtra("upgradeUrl", args.upgradeUrl?.takeIf { it.matches(Regex("^http://127\\.0\\.0\\.1:[0-9]+/.*")) })
            .putExtra("title", args.title).putExtra("artist", args.artist).putExtra("album", args.album)
            .putExtra("durationSeconds", args.durationSeconds)
            .putExtra("coverUrl", args.coverUrl).putExtra("collectionRef", args.collectionRef)
            .putExtra("loudnessGainDb", args.loudnessGainDb).putExtra("loudnessEnabled", args.loudnessEnabled).putExtra("loudnessRevision", args.loudnessRevision)
            .putExtra("position", args.position).putExtra("volume", args.volume).putExtra("playing", args.playing).putExtra("rate", args.rate)
        args.automaticResume?.let { policy ->
            intent.putExtra("automaticResume", true).putExtra("resumeEnabled", policy.enabled)
                .putExtra("resumeThreshold", policy.thresholdSeconds).putExtra("resumeCollection", policy.collection)
                .putExtra("resumeDuration", policy.durationSeconds)
        }
        activity.startForegroundService(intent)
        invoke.resolve()
        if (args.playing) activity.runOnUiThread { playbackNotificationPermission?.requestForPlayback() }
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
                    .putExtra("title", args.title).putExtra("artist", args.artist).putExtra("album", args.album)
                    .putExtra("durationSeconds", args.durationSeconds).putExtra("coverUrl", args.coverUrl))
            } else if (args.action == "largeScreen") {
                largeScreen = args.value > 0
                if (largeScreen) activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            } else if (args.action == "keepAwake") {
                if (args.value > 0) activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else if (args.action == "keyboard") {
                val keyboard = activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
                if (args.value <= 0) keyboard.hideSoftInputFromWindow(activity.window.decorView.windowToken, 0)
                else managedWebView?.let { view -> view.requestFocus(); keyboard.showSoftInput(view, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT) }
            } else if (args.action == "videoFullscreen") {
                setVideoFullscreen(args.value > 0)
            } else if (args.action == "immersive") {
                val drewUnderSystemBars = drawsUnderSystemBars
                val drewUnderStatusBar = drawsUnderStatusBar
                immersive = args.value > 0
                keepSystemInsets = args.keepSystemInsets
                updateSystemBars()
                if (drewUnderSystemBars != drawsUnderSystemBars || drewUnderStatusBar != drawsUnderStatusBar) {
                    managedWebView?.let { androidx.core.view.ViewCompat.requestApplyInsets(it) }
                }
            } else if (args.action == "theme") {
                val light = args.value > 0
                val controller = androidx.core.view.WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                controller.isAppearanceLightStatusBars = light
                controller.isAppearanceLightNavigationBars = light
                updateSystemBars()
                activity.window.decorView.setBackgroundColor(android.graphics.Color.parseColor(if (light) "#f4f6fa" else "#071019"))
            } else {
                val service = PlaybackService.instance
                if (args.action == "resume" && service?.hasResumeTarget() != true) {
                    invoke.reject("原生播放器尚未就绪", "native_not_ready")
                    return@runOnUiThread
                }
                if (args.action.startsWith("sleep") && service == null) {
                    invoke.reject("请先开始播放"); return@runOnUiThread
                }
                if (args.action == "loudness") service?.configureLoudness(args.value > 0,args.settingsRevision)
                else if (args.action == "collection") service?.updateCollection(args.id, args.collectionRef)
                else try {
                    service?.control(args.action, args.value)
                    if (args.action == "resume" && service != null) playbackNotificationPermission?.requestForPlayback()
                } catch (_: IllegalArgumentException) {
                    invoke.reject("当前无法调整播放器设置，请重试")
                    return@runOnUiThread
                }
            }
            invoke.resolve()
        }
    }
    @Command
    fun snapshot(invoke: Invoke) {
        activity.runOnUiThread { invoke.resolve(PlaybackService.instance?.snapshot() ?: JSObject().put("stopped", true)) }
    }
}
