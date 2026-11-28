package app.bilimusic.player

import android.app.Activity
import android.app.Dialog
import android.graphics.Bitmap
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.Window
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import java.net.URI
import java.util.Locale
import kotlin.math.roundToInt

internal class NeteaseWebSession(val musicU: String, val csrf: String)

internal fun isNeteaseLoginPage(url: String): Boolean {
    val uri = runCatching { URI(url) }.getOrNull() ?: return false
    val host = uri.host?.lowercase(Locale.ROOT) ?: return false
    return uri.scheme.equals("https", ignoreCase = true) && uri.userInfo == null &&
        (uri.port == -1 || uri.port == 443) &&
        (host == "163.com" || host.endsWith(".163.com"))
}

internal fun neteaseWebSession(cookieHeader: String?): NeteaseWebSession? {
    var musicU: String? = null
    var csrf = ""
    for (cookie in cookieHeader.orEmpty().split(';')) {
        val pair = cookie.trim().split('=', limit = 2)
        if (pair.size != 2) continue
        when (pair[0]) {
            "MUSIC_U" -> if (pair[1].isNotBlank()) musicU = pair[1]
            "__csrf" -> csrf = pair[1]
        }
    }
    return musicU?.let { NeteaseWebSession(it, csrf) }
}

/** The official page owns sign-in and verification. This WebView has no app JS bridge. */
internal class NeteaseLoginDialog(
    private val activity: Activity,
    private val onResult: (Result<NeteaseWebSession?>) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private var dialog: Dialog? = null
    private var webView: WebView? = null
    private var currentAccount: Button? = null
    private var initialMusicU: String? = null
    private var completed = false
    private val expireLogin = Runnable {
        finish(Result.failure(IllegalStateException("网易云登录等待超时")))
    }
    private val checkSession = object : Runnable {
        override fun run() {
            val session = currentSession()
            if (session != null && session.musicU != initialMusicU) {
                finish(Result.success(session))
                return
            }
            currentAccount?.visibility = if (session == null) View.GONE else View.VISIBLE
            handler.postDelayed(this, 500)
        }
    }

    fun open() {
        try {
            // Android shares the system WebView cookie jar within the app.
            // A saved account is offered explicitly so it cannot replace a new login.
            initialMusicU = readSession()?.musicU
            val browser = WebView(activity).also { webView = it }
            browser.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                useWideViewPort = true
                loadWithOverviewMode = true
                builtInZoomControls = true
                displayZoomControls = false
            }
            browser.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    request.isForMainFrame && !isNeteaseLoginPage(request.url.toString())

                override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                    if (!isNeteaseLoginPage(url)) view.stopLoading()
                }

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    finish(Result.failure(IllegalStateException("网易云登录页已关闭，请重试")))
                    return true
                }
            }
            val body = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                addView(header(), LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
                addView(browser, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            }
            val window = Dialog(activity).also { dialog = it }
            window.requestWindowFeature(Window.FEATURE_NO_TITLE)
            window.setContentView(body)
            window.setCanceledOnTouchOutside(false)
            window.setOnDismissListener { cancel() }
            window.show()
            window.window?.apply {
                setLayout(MATCH_PARENT, MATCH_PARENT)
                setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            }
            browser.loadUrl(LOGIN_PAGE)
            browser.requestFocus()
            handler.post(checkSession)
            handler.postDelayed(expireLogin, NATIVE_TIMEOUT_MS)
        } catch (_: RuntimeException) {
            finish(Result.failure(IllegalStateException("无法打开网易云登录页")))
        }
    }

    private fun header(): View = LinearLayout(activity).apply {
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(16), 0, dp(8), 0)
        addView(TextView(activity).apply {
            text = "网易云音乐"
            textSize = 17f
            typeface = Typeface.DEFAULT_BOLD
            ViewCompat.setAccessibilityHeading(this, true)
            maxLines = 1
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        addView(Button(activity).apply {
            text = "使用当前账号"
            visibility = View.GONE
            currentAccount = this
            setOnClickListener { currentSession()?.let { finish(Result.success(it)) } }
        })
        addView(Button(activity).apply {
            text = "关闭"
            setOnClickListener { cancel() }
        })
    }

    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).roundToInt()

    private fun currentSession(): NeteaseWebSession? {
        val url = webView?.url ?: return null
        return if (isNeteaseLoginPage(url)) readSession() else null
    }

    private fun readSession() = neteaseWebSession(CookieManager.getInstance().getCookie(COOKIE_URL))

    fun cancel() = finish(Result.success(null))

    private fun finish(result: Result<NeteaseWebSession?>) {
        if (completed) return
        completed = true
        handler.removeCallbacks(checkSession)
        handler.removeCallbacks(expireLogin)
        currentAccount = null
        dialog?.let { window ->
            window.setOnDismissListener(null)
            window.dismiss()
        }
        dialog = null
        webView?.let { browser ->
            (browser.parent as? ViewGroup)?.removeView(browser)
            browser.destroy()
        }
        webView = null
        onResult(result)
    }

    private companion object {
        const val LOGIN_PAGE = "https://music.163.com/#/login"
        const val COOKIE_URL = "https://music.163.com/"
        // The shared command normally closes the dialog at five minutes.
        const val NATIVE_TIMEOUT_MS = 305_000L
    }
}
