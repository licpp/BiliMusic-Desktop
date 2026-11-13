package app.bilimusic.player

import android.content.Context
import android.graphics.Canvas
import android.text.Layout
import android.text.StaticLayout
import android.view.Gravity
import android.widget.TextView

internal class ScrollingLyricView(context: Context): TextView(context) {
    private var identity=""
    private var progress=0f
    fun showLyric(value: CharSequence,key: String,active: Boolean=false,position: Float=0f) {
        identity=key
        progress=if(active)position.coerceIn(0f,1f) else 0f
        text=value
        invalidate()
    }
    override fun onDraw(canvas: Canvas) {
        if(text.isNullOrEmpty())return
        paint.color=currentTextColor
        val widthOfText=Layout.getDesiredWidth(text,paint)
        val available=(width-paddingLeft-paddingRight).coerceAtLeast(0)
        val travel=(widthOfText-available).coerceAtLeast(0f)
        val offset=travel*progress
        val x=if(travel>0)paddingLeft-offset else if((gravity and Gravity.HORIZONTAL_GRAVITY_MASK)==Gravity.RIGHT)width-paddingRight-widthOfText else paddingLeft.toFloat()
        val layout=StaticLayout.Builder.obtain(text,0,text.length,paint,kotlin.math.ceil(widthOfText.toDouble()).toInt().coerceAtLeast(1)).setIncludePad(false).setMaxLines(1).build()
        val save=canvas.save();canvas.clipRect(paddingLeft,paddingTop,width-paddingRight,height-paddingBottom)
        canvas.translate(x,paddingTop+((height-paddingTop-paddingBottom-layout.height)/2f).coerceAtLeast(0f));layout.draw(canvas);canvas.restoreToCount(save)
    }
}
