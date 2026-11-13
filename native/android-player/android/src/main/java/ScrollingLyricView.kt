package app.bilimusic.player

import android.content.Context
import android.graphics.Canvas
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import kotlin.math.ceil

// Own measurement and drawing together. TextView's automatic scroll-to-end can
// translate a right-aligned row offscreen before a custom onDraw even runs.
internal class ScrollingLyricView(context: Context): View(context) {
    val paint=TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    var gravity=Gravity.START
    var typeface: Typeface?=null
        set(value){field=value;paint.typeface=value;invalidateLayout()}
    var textSize=28f
        set(value){field=value;paint.textSize=TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP,value,resources.displayMetrics);invalidateLayout()}
    private var value: CharSequence=" "
    private var progress=0f
    private var color=android.graphics.Color.WHITE
    private var textLayout: StaticLayout?=null
    private var shadowPadding=0
    init { textSize=28f;importantForAccessibility=IMPORTANT_FOR_ACCESSIBILITY_YES }
    fun setTextColor(value: Int){color=value;invalidate()}
    fun setShadowLayer(radius: Float,dx: Float,dy: Float,color: Int){paint.setShadowLayer(radius,dx,dy,color);shadowPadding=ceil((radius+kotlin.math.abs(dy)).toDouble()).toInt();invalidateLayout()}
    private fun invalidateLayout(){textLayout=null;requestLayout();invalidate()}
    fun showLyric(text: CharSequence,key: String,active: Boolean=false,position: Float=0f) {
        val changed=value.toString()!=text.toString()
        value=text;if(changed)contentDescription=text
        progress=if(active)position.coerceIn(0f,1f) else 0f
        textLayout=null
        if(changed)requestLayout()
        invalidate()
    }
    private fun lineLayout(): StaticLayout = textLayout ?: StaticLayout.Builder.obtain(value,0,value.length,paint,ceil(Layout.getDesiredWidth(value,paint).toDouble()).toInt().coerceAtLeast(1))
        .setIncludePad(false).setMaxLines(1).build().also{textLayout=it}
    override fun onMeasure(widthMeasureSpec: Int,heightMeasureSpec: Int) {
        val line=lineLayout()
        val lineHeight=maxOf(line.height.toDouble(),paint.fontSpacing.toDouble())
        setMeasuredDimension(resolveSize(ceil(Layout.getDesiredWidth(value,paint).toDouble()).toInt()+paddingLeft+paddingRight,widthMeasureSpec),resolveSize(ceil(lineHeight).toInt()+paddingTop+paddingBottom+2*shadowPadding,heightMeasureSpec))
    }
    override fun onDraw(canvas: Canvas) {
        if(value.isEmpty())return
        paint.color=color
        val line=lineLayout()
        val widthOfText=Layout.getDesiredWidth(value,paint)
        val available=(width-paddingLeft-paddingRight).coerceAtLeast(0)
        val travel=(widthOfText-available).coerceAtLeast(0f)
        val x=if(travel>0)paddingLeft-travel*progress else if((gravity and Gravity.HORIZONTAL_GRAVITY_MASK)==Gravity.RIGHT)width-paddingRight-widthOfText else paddingLeft.toFloat()
        val save=canvas.save();canvas.clipRect(paddingLeft,0,width-paddingRight,height)
        canvas.translate(x,paddingTop+(height-paddingTop-paddingBottom-line.height)/2f);line.draw(canvas);canvas.restoreToCount(save)
    }
}
