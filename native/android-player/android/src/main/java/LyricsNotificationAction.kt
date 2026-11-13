package app.bilimusic.player

import android.media.session.PlaybackState

internal object LyricsNotificationAction {
    const val UNLOCK="lyrics-unlock"
    fun available(enabled: Boolean,locked: Boolean)=enabled && locked
    fun customAction(enabled: Boolean,locked: Boolean): PlaybackState.CustomAction? =
        if(available(enabled,locked))PlaybackState.CustomAction.Builder(UNLOCK,"解锁歌词",R.drawable.ic_lyrics_unlock).build() else null
}
