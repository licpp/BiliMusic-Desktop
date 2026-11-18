package app.bilimusic.player

import android.media.MediaDescription
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.os.Bundle
import org.json.JSONObject

internal data class SystemTrack(
    val id: String,
    val title: String,
    val artist: String,
    val album: String,
    val durationMs: Long,
) {
    constructor(track: JSONObject) : this(
        track.getString("id"), track.mediaText("title").ifBlank { "BiliMusic" },
        track.mediaText("artist"), track.mediaText("album"),
        (track.optDouble("durationSeconds", 0.0) * 1000).toLong().coerceAtLeast(0),
    )

    fun description(): MediaDescription = MediaDescription.Builder()
        .setMediaId(id).setTitle(title).setSubtitle(artist).setDescription(album)
        .setExtras(Bundle().apply {
            putString(MediaMetadata.METADATA_KEY_ALBUM, album)
            if (durationMs > 0) putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
        }).build()
}

internal fun JSONObject.mediaText(key: String): String = if (isNull(key)) "" else optString(key)

/** A compact view of the authoritative queue for Android and AVRCP controllers. */
internal class SystemPlaybackQueue {
    private data class Row(val id: Long, val track: SystemTrack)
    private val identifiers = mutableMapOf<String, Long>()
    private var nextId = 1L
    private var published: List<Row> = emptyList()
    private var tracks: List<JSONObject>? = null
    private var current: SystemTrack? = null

    var activeId = MediaSession.QueueItem.UNKNOWN_ID.toLong()
        private set

    fun resetAccount() {
        identifiers.clear()
        tracks = null
        current = null
    }

    fun update(session: MediaSession, tracks: List<JSONObject>, current: SystemTrack?) {
        if (this.tracks === tracks && this.current == current) return
        if (this.tracks !== tracks) {
            val retained = tracks.mapTo(mutableSetOf()) { it.getString("id") }
            if (current != null) retained.add(current.id)
            identifiers.keys.retainAll(retained)
        }
        this.tracks = tracks
        this.current = current

        val rows = if (current == null) emptyList() else {
            val index = tracks.indexOfFirst { it.getString("id") == current.id }
            // Keeping a bounded slice avoids sending a large playlist over Binder.
            val start = (index - QUEUE_WINDOW / 2).coerceIn(0, (tracks.size - QUEUE_WINDOW).coerceAtLeast(0))
            val window = tracks.subList(start, minOf(start + QUEUE_WINDOW, tracks.size))
            val items = window.map { if (it.getString("id") == current.id) current else SystemTrack(it) }
            (if (index >= 0) items else listOf(current) + items.take(QUEUE_WINDOW - 1)).map {
                Row(identifiers.getOrPut(it.id) { nextId++ }, it)
            }
        }
        activeId = rows.firstOrNull { it.track.id == current?.id }?.id ?: MediaSession.QueueItem.UNKNOWN_ID.toLong()
        if (published != rows) {
            published = rows
            session.setQueue(rows.takeIf { it.isNotEmpty() }?.map { MediaSession.QueueItem(it.track.description(), it.id) })
        }
    }

    fun trackId(queueId: Long): String? = published.firstOrNull { it.id == queueId }?.track?.id

    private companion object {
        const val QUEUE_WINDOW = 50
    }
}
