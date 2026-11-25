package app.bilimusic.player

import android.graphics.*
import android.graphics.drawable.Drawable

internal class FloatingControlIcon(private val kind: Kind): Drawable() {
    enum class Kind { MINUS, PLUS, LOCK, UNLOCK, CLOSE, LANGUAGE }
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply { color=Color.WHITE;style=Paint.Style.STROKE;strokeWidth=1.8f;strokeCap=Paint.Cap.ROUND;strokeJoin=Paint.Join.ROUND }
    private val outline=if(kind==Kind.UNLOCK) Paint(paint).apply { color=0x99102130.toInt();strokeWidth=3.8f } else null
    override fun draw(canvas: Canvas) {
        val scale=minOf(bounds.width(),bounds.height())/24f
        val save=canvas.save();canvas.translate(bounds.left+(bounds.width()-24*scale)/2,bounds.top+(bounds.height()-24*scale)/2);canvas.scale(scale,scale)
        when(kind) {
            Kind.MINUS,Kind.PLUS -> { canvas.drawLine(5f,12f,19f,12f,paint);if(kind==Kind.PLUS)canvas.drawLine(12f,5f,12f,19f,paint) }
            Kind.CLOSE -> { canvas.drawLine(6f,6f,18f,18f,paint);canvas.drawLine(18f,6f,6f,18f,paint) }
            Kind.LANGUAGE -> {
                canvas.drawPath(Path().apply {
                    moveTo(2f, 6f); lineTo(14f, 6f)
                    moveTo(8f, 3f); lineTo(8f, 6f)
                    moveTo(11.5f, 6f); quadTo(10f, 13f, 3f, 16f)
                    moveTo(5f, 9f); quadTo(6f, 12f, 10f, 14f)
                    moveTo(12f, 21f); lineTo(17f, 10f); lineTo(22f, 21f)
                    moveTo(14f, 17f); lineTo(20f, 17f)
                }, paint)
            }
            Kind.LOCK,Kind.UNLOCK -> {
                val shackle=Path().apply {
                    moveTo(7.5f,10f);lineTo(7.5f,7f)
                    if(kind==Kind.LOCK){cubicTo(7.5f,1f,16.5f,1f,16.5f,7f);lineTo(16.5f,10f)}
                    else cubicTo(7.5f,2.2f,13.9f,1.1f,16f,5f)
                }
                fun drawLock(ink: Paint) {
                    canvas.drawRoundRect(4f,10f,20f,21f,2.5f,2.5f,ink)
                    canvas.drawPath(shackle,ink)
                    canvas.drawCircle(12f,15.2f,.8f,ink)
                    canvas.drawLine(12f,16f,12f,18f,ink)
                }
                outline?.let(::drawLock)
                drawLock(paint)
            }
        }
        canvas.restoreToCount(save)
    }
    override fun setAlpha(alpha: Int) { paint.alpha=alpha;outline?.alpha=alpha*153/255;invalidateSelf() }
    override fun setTint(tintColor: Int) { paint.color=tintColor;invalidateSelf() }
    override fun setColorFilter(filter: ColorFilter?) { paint.colorFilter=filter;invalidateSelf() }
    @Deprecated("Deprecated in Android") override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
