package app.bilimusic.player

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.StateListDrawable
import android.widget.ImageButton

// A small translucent circle inside a 44dp target. Only this independent
// window receives taps; the locked lyric window remains fully touch-through.
internal class FloatingLyricsUnlockButton(context: Context,onUnlock: ()->Unit): ImageButton(context) {
    init {
        val density=resources.displayMetrics.density
        val padding=(13*density).toInt()
        setPadding(padding,padding,padding,padding)
        setImageDrawable(FloatingControlIcon(FloatingControlIcon.Kind.UNLOCK))
        imageAlpha=200
        fun circle(color: Int)=InsetDrawable(GradientDrawable().apply{shape=GradientDrawable.OVAL;setColor(color)},(8*density).toInt())
        background=StateListDrawable().apply{
            addState(intArrayOf(android.R.attr.state_pressed),circle(0xB3516A80.toInt()))
            addState(intArrayOf(),circle(0x70516A80))
        }
        contentDescription="解锁悬浮歌词"
        setOnClickListener{onUnlock()}
    }
}
