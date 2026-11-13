package app.bilimusic.player

import android.view.KeyEvent

internal object MediaButtons {
    private val actions = mapOf(
        KeyEvent.KEYCODE_HEADSETHOOK to "toggle", KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "toggle",
        KeyEvent.KEYCODE_MEDIA_PLAY to "resume", KeyEvent.KEYCODE_MEDIA_PAUSE to "pause",
        KeyEvent.KEYCODE_MEDIA_NEXT to "next", KeyEvent.KEYCODE_MEDIA_PREVIOUS to "previous",
        KeyEvent.KEYCODE_MEDIA_STOP to "stop"
    )
    fun supports(key: Int) = actions.containsKey(key)
    // One press produces one action; key-up and held-key repeats are consumed.
    fun action(key: Int, down: Boolean, repeat: Int): String? = if (down && repeat == 0) actions[key] else null
}
