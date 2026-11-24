package app.bilimusic.player

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner

internal class PlaybackNotificationPermission(
    private val activity: ComponentActivity,
    onGranted: () -> Unit,
) : DefaultLifecycleObserver {
    private val preferences = activity.getSharedPreferences("playback_notifications", Context.MODE_PRIVATE)
    // The Tauri plugin may load after STARTED. Register with a stable key so the
    // permission result can still reach the callback after activity recreation.
    private val request = activity.activityResultRegistry.register(
        "bilimusic.playback-notifications", ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) onGranted() }

    init { activity.lifecycle.addObserver(this) }

    fun requestForPlayback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) || activity.isFinishing ||
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED ||
            preferences.getBoolean("requested", false)
        ) return

        // Some Android builds suppress media notifications until explicitly granted.
        // Playback already started and continues regardless of the permission result.
        try {
            request.launch(Manifest.permission.POST_NOTIFICATIONS)
            preferences.edit().putBoolean("requested", true).apply()
        } catch (_: ActivityNotFoundException) {
            // Some devices have no system permission prompt.
        }
    }

    override fun onDestroy(owner: LifecycleOwner) {
        request.unregister()
    }
}
