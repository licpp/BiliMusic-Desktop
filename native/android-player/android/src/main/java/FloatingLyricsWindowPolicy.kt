package app.bilimusic.player

internal object FloatingLyricsWindowPolicy {
    // Android 12+ rejects touch-through from opaque application overlays,
    // including windows whose actual background pixels are transparent.
    fun alpha(locked: Boolean, api: Int, maximum: Float): Float =
        if (locked && api >= 31) minOf(.8f,maximum.coerceIn(0f,1f)) else 1f

}
