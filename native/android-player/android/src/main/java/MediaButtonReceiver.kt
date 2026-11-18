package app.bilimusic.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.view.KeyEvent

/** Explicit system media-key destination; never opens an Activity or another player. */
class MediaButtonReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MEDIA_BUTTON) return
        val key = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return
        val action = MediaButtons.action(key.keyCode, key.action == KeyEvent.ACTION_DOWN, key.repeatCount) ?: return
        PlaybackService.instance?.controlFromMediaSession(action)
    }
}
