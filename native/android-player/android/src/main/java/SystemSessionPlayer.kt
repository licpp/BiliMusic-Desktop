package app.bilimusic.player

import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/** Projects the service's queue and transport onto Media3, using the service's playback clock. */
@OptIn(UnstableApi::class)
internal class SystemSessionPlayer(
    private val control: (String) -> Unit,
    private val seek: (Long) -> Unit,
    private val select: (String) -> Unit,
) : SimpleBasePlayer(Looper.getMainLooper()) {
    private val audioAttributes = AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build()
    private var rows: List<SystemPlaybackQueue.Row> = emptyList()
    private var playlist: List<MediaItemData> = emptyList()
    private var currentIndex = -1
    private var mediaText: SystemMediaText? = null
    private var artwork: ByteArray? = null
    private var projection = State.Builder().build()

    fun update(
        queue: SystemPlaybackQueue,
        mediaText: SystemMediaText,
        artwork: ByteArray?,
        status: String,
        positionMs: Long,
        rate: Float,
        canSkip: Boolean,
        error: String?,
    ) {
        val commands = Player.Commands.Builder()
            .addAll(COMMAND_GET_CURRENT_MEDIA_ITEM, COMMAND_GET_TIMELINE, COMMAND_GET_METADATA,
                COMMAND_GET_AUDIO_ATTRIBUTES, COMMAND_PLAY_PAUSE, COMMAND_STOP)
        if (queue.currentIndex >= 0) commands.add(COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
        if (canSkip) commands.addAll(COMMAND_SEEK_TO_NEXT, COMMAND_SEEK_TO_PREVIOUS,
            COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, COMMAND_SEEK_TO_MEDIA_ITEM)

        val state = projection.buildUpon().clearPositionDiscontinuity()
        val queueChanged = rows !== queue.rows
        val indexChanged = currentIndex != queue.currentIndex
        if (queueChanged) {
            rows = queue.rows
            playlist = rows.map { row ->
                val track = row.track
                val metadata = MediaMetadata.Builder().setTitle(track.title).setArtist(track.artist)
                    .setSubtitle(track.artist).setAlbumTitle(track.album).setDescription(track.album)
                    .setDurationMs(track.durationMs.takeIf { it > 0 })
                MediaItemData.Builder(row.uid)
                    .setMediaItem(MediaItem.Builder().setMediaId(track.id).setMediaMetadata(metadata.build()).build())
                    .setDurationUs(if (track.durationMs > 0) track.durationMs * 1000 else C.TIME_UNSET)
                    .setIsSeekable(true)
                    .build()
            }
        }
        if (queueChanged || indexChanged || this.mediaText != mediaText || this.artwork !== artwork) {
            this.mediaText = mediaText
            this.artwork = artwork
            state.setPlaylist(playlist.mapIndexed { index, item ->
                if (index != queue.currentIndex) return@mapIndexed item
                val original = item.mediaItem.mediaMetadata
                val current = original.buildUpon()
                    .setTitle(mediaText.title)
                    .setDisplayTitle(mediaText.title)
                    .setArtist(mediaText.subtitle)
                    .setSubtitle(mediaText.subtitle)
                    .setArtworkData(artwork, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
                item.buildUpon().setMediaMetadata(current.build()).build()
            })
        }
        if (indexChanged && rows.getOrNull(queue.currentIndex) != null && currentIndex >= 0) {
            // Keep the framework PlaybackState's active queue index current after reordering.
            state.setPositionDiscontinuity(Player.DISCONTINUITY_REASON_INTERNAL, positionMs.coerceAtLeast(0))
        }
        currentIndex = queue.currentIndex
        val playbackState = when {
            rows.isEmpty() || status == "error" -> STATE_IDLE
            status == "buffering" -> STATE_BUFFERING
            else -> STATE_READY
        }
        projection = state.setAvailableCommands(commands.build()).setAudioAttributes(audioAttributes)
            .setCurrentMediaItemIndex(queue.currentIndex.takeIf { it >= 0 } ?: C.INDEX_UNSET)
            .setContentPositionMs(positionMs.coerceAtLeast(0))
            .setPlaybackState(playbackState)
            .setPlayWhenReady(playbackState != STATE_IDLE && (status == "playing" || status == "buffering"),
                PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setPlaybackParameters(PlaybackParameters(rate))
            .setPlayerError(error?.takeIf { playbackState == STATE_IDLE }?.let {
                PlaybackException(it, null, PlaybackException.ERROR_CODE_IO_UNSPECIFIED)
            })
            .build()
        invalidateState()
    }

    override fun getState(): State = projection

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        control(if (playWhenReady) "resume" else "pause")
        return Futures.immediateVoidFuture()
    }

    override fun handleStop(): ListenableFuture<*> {
        control("stop")
        return Futures.immediateVoidFuture()
    }

    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        when (seekCommand) {
            COMMAND_SEEK_TO_NEXT, COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> control("next")
            COMMAND_SEEK_TO_PREVIOUS, COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> control("previous")
            COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM -> if (positionMs != C.TIME_UNSET) seek(positionMs)
            COMMAND_SEEK_TO_MEDIA_ITEM -> rows.getOrNull(mediaItemIndex)?.let { select(it.track.id) }
        }
        return Futures.immediateVoidFuture()
    }
}
