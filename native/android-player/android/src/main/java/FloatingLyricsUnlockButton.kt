package app.bilimusic.player

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.StateListDrawable
import android.view.MotionEvent
import android.widget.ImageButton

// Keep the 44dp target even when the button has no idle background.
internal class FloatingLyricsUnlockButton(
    context: Context,
    private val onRevealedChanged: (FloatingLyricsUnlockButton, Boolean) -> Unit,
    onUnlock: () -> Unit
) : ImageButton(context) {
    private var revealed = true
    private val hideWhenIdle = Runnable { setRevealed(false) }

    init {
        val density=resources.displayMetrics.density
        val padding=(13*density).toInt()
        setPadding(padding,padding,padding,padding)
        setImageDrawable(FloatingControlIcon(FloatingControlIcon.Kind.UNLOCK))
        imageAlpha=230
        fun circle(color: Int)=InsetDrawable(GradientDrawable().apply{shape=GradientDrawable.OVAL;setColor(color)},(8*density).toInt())
        background=StateListDrawable().apply{
            addState(intArrayOf(android.R.attr.state_pressed),circle(0x66516A80))
            addState(intArrayOf(),circle(Color.TRANSPARENT))
        }
        contentDescription="解锁悬浮歌词"
        setOnClickListener{onUnlock()}
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        stayVisibleBriefly()
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(hideWhenIdle)
        super.onDetachedFromWindow()
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_OUTSIDE -> {
                // The original gesture continues in the window Android selected.
                stayVisibleBriefly()
                return true
            }
            MotionEvent.ACTION_DOWN -> removeCallbacks(hideWhenIdle)
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> stayVisibleBriefly()
        }
        return super.dispatchTouchEvent(event)
    }

    private fun stayVisibleBriefly() {
        if (!isAttachedToWindow) return
        setRevealed(true)
        removeCallbacks(hideWhenIdle)
        postDelayed(hideWhenIdle, 4_000L)
    }

    private fun setRevealed(value: Boolean) {
        if (revealed == value) return
        revealed = value
        importantForAccessibility = if (value) IMPORTANT_FOR_ACCESSIBILITY_AUTO else IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        onRevealedChanged(this, value)
    }
}
