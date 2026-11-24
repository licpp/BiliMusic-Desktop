package app.bilimusic.player

import android.content.Intent
import android.os.Handler
import android.view.KeyEvent
import android.view.ViewConfiguration
import androidx.core.content.IntentCompat

internal fun Intent.mediaButtonKey(): KeyEvent? {
    if (action != Intent.ACTION_MEDIA_BUTTON) return null
    return IntentCompat.getParcelableExtra(this, Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
}

internal fun KeyEvent.startsPausedPlayback(): Boolean = action == KeyEvent.ACTION_DOWN && repeatCount == 0 &&
    (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ||
        keyCode == KeyEvent.KEYCODE_HEADSETHOOK)

/** Raw headset keys use one gesture state for session and broadcast delivery. */
internal class MediaButtons(
    private val handler: Handler,
    private val canSkipNext: () -> Boolean,
    private val dispatch: (String) -> Unit,
) {
    private data class Press(val code: Int, val device: Int, val downTime: Long, val eventTime: Long)

    private val recentPresses = ArrayDeque<Press>()
    private var pendingDevice: Int? = null
    private val singleTap = Runnable {
        pendingDevice = null
        dispatch("toggle")
    }

    fun handle(key: KeyEvent): Boolean {
        val action = actions[key.keyCode] ?: return false
        if (key.action != KeyEvent.ACTION_DOWN || key.repeatCount != 0) return true
        if (key.eventTime > 0 && key.downTime > 0) {
            // A session and its receiver can observe the same physical event.
            val press = Press(key.keyCode, key.deviceId, key.downTime, key.eventTime)
            if (press in recentPresses) return true
            recentPresses.addLast(press)
            if (recentPresses.size > 4) recentPresses.removeFirst()
        }
        if (action != "toggle") {
            cancel()
            dispatch(action)
        } else if (pendingDevice == key.deviceId) {
            cancel()
            dispatch(if (canSkipNext()) "next" else "toggle")
        } else {
            if (pendingDevice != null) {
                cancel()
                dispatch("toggle")
            }
            pendingDevice = key.deviceId
            handler.postDelayed(singleTap, ViewConfiguration.getDoubleTapTimeout().toLong())
        }
        return true
    }

    fun cancel() {
        if (pendingDevice == null) return
        pendingDevice = null
        handler.removeCallbacks(singleTap)
    }

    private companion object {
        val actions = mapOf(
            KeyEvent.KEYCODE_HEADSETHOOK to "toggle", KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "toggle",
            KeyEvent.KEYCODE_MEDIA_PLAY to "resume", KeyEvent.KEYCODE_MEDIA_PAUSE to "pause",
            KeyEvent.KEYCODE_MEDIA_NEXT to "next", KeyEvent.KEYCODE_MEDIA_PREVIOUS to "previous",
            KeyEvent.KEYCODE_MEDIA_STOP to "stop"
        )
    }
}
