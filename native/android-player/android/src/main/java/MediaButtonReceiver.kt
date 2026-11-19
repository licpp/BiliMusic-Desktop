package app.bilimusic.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Explicit system media-key destination; never opens an Activity or another player. */
class MediaButtonReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val key = intent.mediaButtonKey() ?: return
        PlaybackService.instance?.handleMediaButton(key)
    }
}
