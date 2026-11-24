package app.bilimusic.player

import android.Manifest.permission.POST_NOTIFICATIONS
import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PlaybackNotificationPermissionTest {
    @Test fun permissionIsDeclaredInTheMergedManifest() {
        Robolectric.buildActivity(ComponentActivity::class.java).setup().use { controller ->
            val activity = controller.get()
            val info = activity.packageManager.getPackageInfo(activity.packageName, PackageManager.GET_PERMISSIONS)
            assertTrue(info.requestedPermissions.orEmpty().contains(POST_NOTIFICATIONS))
        }
    }

    @Test fun foregroundPlaybackRequestsPermissionAndDeliversGrant() {
        Robolectric.buildActivity(ComponentActivity::class.java).setup().use { controller ->
            val activity = controller.get()
            var grants = 0
            val permission = PlaybackNotificationPermission(activity) { grants++ }
            permission.requestForPlayback()
            val prompt = shadowOf(activity).lastRequestedPermission
            assertArrayEquals(arrayOf(POST_NOTIFICATIONS), prompt.requestedPermissions)
            assertEquals(0, grants)
            activity.onRequestPermissionsResult(prompt.requestCode, prompt.requestedPermissions, intArrayOf(PackageManager.PERMISSION_GRANTED))
            assertEquals(1, grants)
        }
    }

    @Test fun backgroundPlaybackDoesNotAskAndDenialIsRememberedOnRecreation() {
        Robolectric.buildActivity(ComponentActivity::class.java).setup().use { controller ->
            val activity = controller.get()
            val permission = PlaybackNotificationPermission(activity) { fail("Denied permission cannot refresh the notification") }
            controller.pause().stop()
            permission.requestForPlayback()
            assertNull(shadowOf(activity).lastRequestedPermission)
            controller.restart().start().resume()
            permission.requestForPlayback()
            val prompt = shadowOf(activity).lastRequestedPermission
            activity.onRequestPermissionsResult(prompt.requestCode, prompt.requestedPermissions, intArrayOf(PackageManager.PERMISSION_DENIED))
        }
        Robolectric.buildActivity(ComponentActivity::class.java).setup().use { controller ->
            val activity = controller.get()
            PlaybackNotificationPermission(activity) { fail("Unexpected grant") }.requestForPlayback()
            assertNull(shadowOf(activity).lastRequestedPermission)
        }
    }

    @Test fun alreadyAuthorizedInstallDoesNotAsk() {
        Robolectric.buildActivity(ComponentActivity::class.java).setup().use { controller ->
            val activity = controller.get()
            shadowOf(activity).grantPermissions(POST_NOTIFICATIONS)
            PlaybackNotificationPermission(activity) { fail("No request is needed") }.requestForPlayback()
            assertNull(shadowOf(activity).lastRequestedPermission)
        }
    }

    @Test @Config(sdk = [28]) fun olderAndroidDoesNotAsk() {
        Robolectric.buildActivity(ComponentActivity::class.java).setup().use { controller ->
            val activity = controller.get()
            PlaybackNotificationPermission(activity) { fail("No runtime permission on this Android version") }.requestForPlayback()
            assertNull(shadowOf(activity).lastRequestedPermission)
        }
    }
}
