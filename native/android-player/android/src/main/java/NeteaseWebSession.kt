package app.bilimusic.player

import android.os.Build
import android.webkit.CookieManager
import android.webkit.WebStorage

/**
 * Removes the NetEase web session from the app webview's cookie store.
 *
 * The Android embedded login runs in the app's only webview, so the cookies an
 * earlier attempt wrote stay there until something deletes them; wry cannot
 * delete a cookie on Android and `clearAllBrowsingData` leaves cookies alone.
 * The store is shared, so only 163.com entries are touched -- the Bilibili
 * login lives in the same jar.
 */
internal object NeteaseWebSession {
    private const val ORIGIN = "https://music.163.com/"

    /** The forms a NetEase cookie's key can take; a deletion has to match it. */
    private val DOMAINS = listOf("music.163.com", ".music.163.com", "163.com", ".163.com")

    /** Names only: the jar also carries the values, which never leave here. */
    class Report(val removed: List<String>, val remaining: List<String>)

    fun clear(): Report {
        val manager = CookieManager.getInstance()
        val names = names(manager.getCookie(ORIGIN))
        for (name in names) {
            for (domain in DOMAINS) {
                manager.setCookie(ORIGIN, "$name=; Max-Age=0; Path=/; Domain=$domain")
            }
        }
        manager.flush()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // The page also caches the account it last showed; the cookies are
            // the session, this only keeps the old one from reappearing while
            // the reset page loads.
            runCatching { WebStorage.getInstance().deleteOrigin("https://music.163.com") }
        }
        return Report(names, names(manager.getCookie(ORIGIN)))
    }

    /** `name=value; name2=value2` as NAMES, dropping anything unusable. */
    fun names(jar: String?): List<String> = jar.orEmpty()
        .split(';')
        .mapNotNull { entry -> entry.substringBefore('=').trim().takeIf(String::isNotEmpty) }
        .distinct()
}
