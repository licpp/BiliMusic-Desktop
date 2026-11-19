package app.bilimusic.player

import android.view.WindowManager.LayoutParams
import kotlin.math.roundToInt

internal object FloatingLyricsWindowPolicy {
    data class Position(val horizontal: Float, val vertical: Float) {
        fun pixels(maxX: Int, maxY: Int): Pair<Int, Int> =
            (horizontal * maxX).roundToInt() to (vertical * maxY).roundToInt()
    }

    fun savedPosition(horizontal: Float, vertical: Float): Position? =
        if (horizontal in 0f..1f && vertical in 0f..1f) Position(horizontal, vertical) else null

    fun capturePosition(x: Int, y: Int, maxX: Int, maxY: Int): Position {
        fun fraction(offset: Int, limit: Int) =
            if (limit > 0) offset.coerceIn(0, limit).toFloat() / limit else 0f
        return Position(fraction(x, maxX), fraction(y, maxY))
    }

    fun showUnlock(enabled: Boolean, locked: Boolean, visible: Boolean, attached: Boolean) = enabled && locked && visible && attached

    fun unlockFlags(revealed: Boolean): Int {
        val flags = LayoutParams.FLAG_NOT_FOCUSABLE or LayoutParams.FLAG_NOT_TOUCH_MODAL or
            LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
        return if (revealed) flags else flags or LayoutParams.FLAG_NOT_TOUCHABLE
    }

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
