package app.bilimusic.player

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.widget.ImageButton
import android.widget.LinearLayout

internal class FloatingLyricsToolbar(context: Context,action: (Action)->Unit): LinearLayout(context) {
    enum class Action { SMALLER, LARGER, LOCK, CLOSE }
    init {
        val density=resources.displayMetrics.density
        orientation=HORIZONTAL;gravity=Gravity.END
        background=GradientDrawable().apply{setColor(0x99516A80.toInt());cornerRadius=8*density}
        fun button(icon: FloatingControlIcon.Kind,description: String,value: Action) {
            addView(ImageButton(context).apply {
                val padding=(11*density).toInt()
                setImageDrawable(FloatingControlIcon(icon));setPadding(padding,padding,padding,padding)
                background=StateListDrawable().apply {
                    addState(intArrayOf(android.R.attr.state_pressed),GradientDrawable().apply{setColor(0x33FFFFFF);cornerRadius=8*density})
                    addState(intArrayOf(),ColorDrawable(Color.TRANSPARENT))
                }
                contentDescription=description;setOnClickListener{action(value)}
            },LayoutParams((44*density).toInt(),(44*density).toInt()))
        }
        button(FloatingControlIcon.Kind.MINUS,"减小歌词字号",Action.SMALLER)
        button(FloatingControlIcon.Kind.PLUS,"增大歌词字号",Action.LARGER)
        button(FloatingControlIcon.Kind.LOCK,"锁定悬浮歌词",Action.LOCK)
        button(FloatingControlIcon.Kind.CLOSE,"关闭悬浮歌词",Action.CLOSE)
    }
}
