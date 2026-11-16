package app.bilimusic.player

import android.content.Context
import org.json.JSONObject
import org.json.JSONArray

/** Reuses the audio service clock; never creates another media session. */
internal object SystemTitleLyrics {
    private var data = JSONObject()
    private var enabled = false
    fun configure(context: Context, value: Boolean) {
        enabled = value
        context.getSharedPreferences("bilimusic-media", Context.MODE_PRIVATE).edit().putBoolean("lyricTitle", value).apply()
    }
    fun attach(context: Context) { enabled = context.getSharedPreferences("bilimusic-media", Context.MODE_PRIVATE).getBoolean("lyricTitle", false) }
    fun update(value: JSONObject) { data = value }
    fun title(id: String, position: Double, original: String): String {
        if (!position.isFinite() || !enabled || id.isEmpty() || data.optString("id") != id) return original
        val lines = data.optJSONArray("lines") ?: return original
        val time = position * 1000 - data.optDouble("biasMs", 0.0)
        val index = nativeLyricIndex(lines,time)
        if (index < 0) return original
        val line = lines.getJSONObject(index)
        if (data.optBoolean("subtitles") && line.has("endTimeMs") && time >= line.optDouble("endTimeMs")) return original
        return lyricDisplayText(line.optString("text")).trim().takeIf { it.isNotEmpty() } ?: original
    }
}

private val musicalDecorations = Regex("[♪♫♬♩🎵🎶]")
internal fun lyricDisplayText(text: String) = text.replace(musicalDecorations, "")
internal fun nativeLyricIndex(lines: JSONArray?, time: Double): Int {
    if (lines == null || !time.isFinite()) return -1
    var low = 0; var high = lines.length()
    while (low < high) { val mid = (low + high) ushr 1; if ((lines.optJSONObject(mid)?.optDouble("timeMs",Double.MAX_VALUE) ?: Double.MAX_VALUE) <= time) low = mid + 1 else high = mid }
    return low - 1
}
