package app.bilimusic.player

import android.app.Activity
import android.os.Looper
import android.webkit.CookieManager
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class NeteaseLoginDialogTest {
    @Test fun allowsOfficialHttpsNavigationAndRejectsLookalikeHosts() {
        assertTrue(isNeteaseLoginPage("https://music.163.com/#/login"))
        assertTrue(isNeteaseLoginPage("https://aq.163.com:443/verify"))
        assertFalse(isNeteaseLoginPage("http://music.163.com/"))
        assertFalse(isNeteaseLoginPage("https://music.163.com.evil.test/"))
        assertFalse(isNeteaseLoginPage("https://evil.test@music.163.com/"))
        assertFalse(isNeteaseLoginPage("https://music.163.com:444/"))
        assertFalse(isNeteaseLoginPage("intent://music.163.com/"))
    }

    @Test fun usesOnlyTheOfficialSessionCookies() {
        val session = neteaseWebSession("other=ignore; __csrf=csrf; MUSIC_U=opaque=value")
        assertEquals("opaque=value", session?.musicU)
        assertEquals("csrf", session?.csrf)
        assertNull(neteaseWebSession("MUSIC_U= ; __csrf=csrf; MUSIC_U_OTHER=not-a-session"))
    }

    @Test fun systemBackAndProgrammaticCancelCompleteTheSameDialogOnlyOnce() {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val results = mutableListOf<Result<NeteaseWebSession?>>()
        val login = NeteaseLoginDialog(controller.get()) { result -> results.add(result) }
        login.open()
        val dialog = ShadowDialog.getLatestDialog()
        assertTrue(dialog.isShowing)
        @Suppress("DEPRECATION")
        dialog.onBackPressed()
        shadowOf(Looper.getMainLooper()).idle()
        login.cancel()
        assertFalse(dialog.isShowing)
        assertEquals(1, results.size)
        assertNull(results.single().getOrThrow())
        controller.destroy()
    }

    @Test fun savedSessionDoesNotFinishSilentlyAndANewSessionCompletesLogin() {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val cookies = CookieManager.getInstance()
        val account = "https://music.163.com/"
        cookies.setCookie(account, "MUSIC_U=previous; Path=/; Secure")
        val results = mutableListOf<Result<NeteaseWebSession?>>()
        val login = NeteaseLoginDialog(controller.get()) { result -> results.add(result) }
        login.open()
        val main = shadowOf(Looper.getMainLooper())
        main.idle()
        assertTrue(ShadowDialog.getLatestDialog().isShowing)
        assertTrue(results.isEmpty())

        cookies.setCookie(account, "MUSIC_U=fresh; Path=/; Secure")
        main.idleFor(Duration.ofMillis(500))
        assertFalse(ShadowDialog.getLatestDialog().isShowing)
        assertEquals("fresh", results.single().getOrThrow()?.musicU)
        controller.destroy()
    }
}
