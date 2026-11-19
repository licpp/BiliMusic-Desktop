package app.bilimusic.player

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
}

internal fun JSONObject.mediaText(key: String): String = if (isNull(key)) "" else optString(key)

/** A compact view of the authoritative queue for Android and AVRCP controllers. */
internal class SystemPlaybackQueue {
    data class Row(val uid: Long, val track: SystemTrack)
    private val identifiers = mutableMapOf<String, Long>()
    private var nextId = 1L
    private var tracks: List<JSONObject>? = null
    private var current: SystemTrack? = null

    var rows: List<Row> = emptyList()
        private set

    var currentIndex = -1
        private set

    fun resetAccount() {
        identifiers.clear()
        tracks = null
        current = null
        rows = emptyList()
        currentIndex = -1
    }

    fun update(tracks: List<JSONObject>, current: SystemTrack?) {
        if (this.tracks === tracks && this.current == current) return
        if (this.tracks !== tracks) {
            val retained = tracks.mapTo(mutableSetOf()) { it.getString("id") }
            if (current != null) retained.add(current.id)
            identifiers.keys.retainAll(retained)
        }
        this.tracks = tracks
        this.current = current

        rows = if (current == null) emptyList() else {
            val index = tracks.indexOfFirst { it.getString("id") == current.id }
            // Keeping a bounded slice avoids sending a large playlist over Binder.
            val start = (index - QUEUE_WINDOW / 2).coerceIn(0, (tracks.size - QUEUE_WINDOW).coerceAtLeast(0))
            val window = tracks.subList(start, minOf(start + QUEUE_WINDOW, tracks.size))
            val items = window.map { if (it.getString("id") == current.id) current else SystemTrack(it) }
            (if (index >= 0) items else listOf(current) + items.take(QUEUE_WINDOW - 1)).map {
                Row(identifiers.getOrPut(it.id) { nextId++ }, it)
            }
        }
        currentIndex = rows.indexOfFirst { it.track.id == current?.id }
    }

    private companion object {
        const val QUEUE_WINDOW = 50
    }
}
