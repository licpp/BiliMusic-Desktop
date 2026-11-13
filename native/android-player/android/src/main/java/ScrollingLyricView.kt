package app.bilimusic.player

import android.content.Context
import android.graphics.Canvas
import android.text.Layout
import android.text.StaticLayout
import android.view.Gravity
import android.widget.TextView

internal class ScrollingLyricView(context: Context): TextView(context) {
    private var identity=""
    private var began=android.os.SystemClock.uptimeMillis()
    fun showLyric(value: CharSequence,key: String) {
        if(key!=identity){identity=key;began=android.os.SystemClock.uptimeMillis()}
        text=value
    }
    override fun onDraw(canvas: Canvas) {
        if(text.isNullOrEmpty())return
        paint.color=currentTextColor
        val widthOfText=Layout.getDesiredWidth(text,paint)
        val available=(width-paddingLeft-paddingRight).coerceAtLeast(0)
        val travel=(widthOfText-available).coerceAtLeast(0f)
        val elapsed=(android.os.SystemClock.uptimeMillis()-began).toFloat()
        val hold=1500f;val trip=if(travel>0)travel/(32*resources.displayMetrics.density)*1000 else 0f
        val phase=if(trip>0)elapsed%((hold+trip)*2) else 0f
        val offset=when { phase<hold->0f;phase<hold+trip->travel*(phase-hold)/trip;phase<hold*2+trip->travel;else->travel*(1-(phase-hold*2-trip)/trip) }
        val x=if(travel>0)paddingLeft-offset else if((gravity and Gravity.HORIZONTAL_GRAVITY_MASK)==Gravity.RIGHT)width-paddingRight-widthOfText else paddingLeft.toFloat()
        val layout=StaticLayout.Builder.obtain(text,0,text.length,paint,kotlin.math.ceil(widthOfText.toDouble()).toInt().coerceAtLeast(1)).setIncludePad(false).setMaxLines(1).build()
        val save=canvas.save();canvas.clipRect(paddingLeft,paddingTop,width-paddingRight,height-paddingBottom)
        canvas.translate(x,paddingTop+((height-paddingTop-paddingBottom-layout.height)/2f).coerceAtLeast(0f));layout.draw(canvas);canvas.restoreToCount(save)
    }
}
