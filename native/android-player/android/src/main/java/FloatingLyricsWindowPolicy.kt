package app.bilimusic.player

internal object FloatingLyricsWindowPolicy {
    // Android 12+ rejects touch-through from opaque application overlays,
    // including windows whose actual background pixels are transparent.
    fun alpha(locked: Boolean, api: Int, maximum: Float): Float =
        if (locked && api >= 31) minOf(.8f,maximum.coerceIn(0f,1f)) else 1f

    fun unlockPosition(x: Int,y: Int,width: Int,height: Int,screenWidth: Int,screenHeight: Int,size: Int,gap: Int): Pair<Int,Int> {
        val left=(x+width-size).coerceIn(0,(screenWidth-size).coerceAtLeast(0))
        val top=when {
            y >= size+gap -> y-size-gap
            y+height+gap+size <= screenHeight -> y+height+gap
            else -> y
        }.coerceIn(0,(screenHeight-size).coerceAtLeast(0))
        return left to top
    }
}
