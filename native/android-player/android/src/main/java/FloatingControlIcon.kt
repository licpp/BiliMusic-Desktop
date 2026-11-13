package app.bilimusic.player

import android.graphics.*
import android.graphics.drawable.Drawable

internal class FloatingControlIcon(private val kind: Kind): Drawable() {
    enum class Kind { MINUS, PLUS, LOCK, UNLOCK, CLOSE }
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply { color=Color.WHITE;style=Paint.Style.STROKE;strokeWidth=2f;strokeCap=Paint.Cap.ROUND;strokeJoin=Paint.Join.ROUND }
    override fun draw(canvas: Canvas) {
        val scale=minOf(bounds.width(),bounds.height())/24f
        val save=canvas.save();canvas.translate(bounds.left+(bounds.width()-24*scale)/2,bounds.top+(bounds.height()-24*scale)/2);canvas.scale(scale,scale)
        when(kind) {
            Kind.MINUS,Kind.PLUS -> { canvas.drawLine(5f,12f,19f,12f,paint);if(kind==Kind.PLUS)canvas.drawLine(12f,5f,12f,19f,paint) }
            Kind.CLOSE -> { canvas.drawLine(6f,6f,18f,18f,paint);canvas.drawLine(18f,6f,6f,18f,paint) }
            Kind.LOCK,Kind.UNLOCK -> {
                canvas.drawRoundRect(5f,10f,19f,21f,2f,2f,paint)
                val shackle=Path().apply {moveTo(8f,10f);lineTo(8f,7f);cubicTo(8f,1.7f,16f,1.7f,16f,7f);if(kind==Kind.LOCK)lineTo(16f,10f)}
                canvas.drawPath(shackle,paint)
            }
        }
        canvas.restoreToCount(save)
    }
    override fun setAlpha(alpha: Int) { paint.alpha=alpha;invalidateSelf() }
    override fun setColorFilter(filter: ColorFilter?) { paint.colorFilter=filter;invalidateSelf() }
    @Deprecated("Deprecated in Android") override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
