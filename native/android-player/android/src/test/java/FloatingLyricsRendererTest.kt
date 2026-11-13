package app.bilimusic.player

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FloatingLyricsRendererTest {
    private val context get()=RuntimeEnvironment.getApplication()
    private fun label(text: String,right: Boolean=false,size: Float=28f)=ScrollingLyricView(context).apply {
        textSize=size;gravity=if(right)Gravity.END else Gravity.START
        typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL)
        setTextColor(Color.WHITE);showLyric(text,"row")
    }
    private fun arrange(view: View,width: Int=360) {
        view.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(2000,View.MeasureSpec.AT_MOST))
        view.layout(0,0,view.measuredWidth,view.measuredHeight)
    }
    private fun pixels(view: View): Bitmap=Bitmap.createBitmap(view.width,view.height,Bitmap.Config.ARGB_8888).also{view.draw(Canvas(it))}
    private fun visiblePixels(bitmap: Bitmap,top: Int,bottom: Int): Int {
        var total=0
        for(y in top until bottom)for(x in 0 until bitmap.width)if(Color.alpha(bitmap.getPixel(x,y))>0)total++
        return total
    }
    @Test fun bothRowsDrawWhenTheRightAlignedSentenceOverflows() {
        for(size in listOf(28f,48f)) {
            val top=label("First visible lyric line",size=size)
            val bottom=label("The second long lyric line must remain visible before and while it becomes active",true,size)
            val rows=LinearLayout(context).apply {
                orientation=LinearLayout.VERTICAL
                addView(top,LinearLayout.LayoutParams(-1,-2));addView(bottom,LinearLayout.LayoutParams(-1,-2))
            }
            arrange(rows);val bitmap=pixels(rows)
            assertTrue(visiblePixels(bitmap,top.top,top.bottom)>30)
            assertTrue("The lower row must paint pixels even with END alignment",visiblePixels(bitmap,bottom.top,bottom.bottom)>30)
            assertEquals(0,bottom.scrollX);assertTrue(bottom.bottom<=rows.height)
            bottom.showLyric("The second long lyric line must remain visible before and while it becomes active","row",true,.8f)
            val advanced=pixels(rows)
            assertTrue(visiblePixels(advanced,bottom.top,bottom.bottom)>30)
        }
    }
    @Test fun bothRowsHaveHeightBeforeLyricsArriveAndControlsDoNotShiftThem() {
        val first=label("");val second=label("",true)
        val tools=FloatingLyricsToolbar(context){}.apply{visibility=View.INVISIBLE}
        val rows=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL;addView(first,LinearLayout.LayoutParams(-1,-2));addView(second,LinearLayout.LayoutParams(-1,-2));addView(tools,LinearLayout.LayoutParams(-1,-2))}
        arrange(rows)
        assertTrue(first.height>0 && second.height>0)
        first.showLyric("The first line","a");second.showLyric("The second line","b")
        arrange(rows);val y=second.top;val height=rows.height
        tools.visibility=View.VISIBLE;arrange(rows)
        assertEquals(y,second.top);assertEquals(height,rows.height)
    }
    @Test fun notificationPublishesARealUnlockCommandWithoutChangingPlaybackActions() {
        val action=LyricsNotificationAction.customAction(true,true)!!
        assertEquals("lyrics-unlock",action.action);assertEquals("解锁歌词",action.name.toString())
        assertEquals(R.drawable.ic_lyrics_unlock,action.icon)
        val state=android.media.session.PlaybackState.Builder().setActions(android.media.session.PlaybackState.ACTION_SKIP_TO_NEXT or android.media.session.PlaybackState.ACTION_SKIP_TO_PREVIOUS).addCustomAction(action).build()
        assertEquals(1,state.customActions.size)
        assertTrue(state.actions and android.media.session.PlaybackState.ACTION_SKIP_TO_NEXT != 0L)
        assertTrue(state.actions and android.media.session.PlaybackState.ACTION_SKIP_TO_PREVIOUS != 0L)
        assertNull(LyricsNotificationAction.customAction(true,false));assertNull(LyricsNotificationAction.customAction(false,true))
    }
    @Test fun renderActualRowsAndToolbarInBothBackgrounds() {
        val actions=mutableListOf<FloatingLyricsToolbar.Action>()
        for((name,background)in listOf("light" to 0xFFF4F7FA.toInt(),"dark" to 0xFF14212B.toInt())) {
            val first=label("第一行歌词 · 正在播放").apply{setTextColor(0xFFB4F3E9.toInt());setShadowLayer(2f,0f,1f,0x66000000)}
            val second=label("第二行歌词 · 等待下一句",true).apply{setTextColor(0xFF91A6B5.toInt())}
            val toolbar=FloatingLyricsToolbar(context){actions.add(it)}
            val rows=LinearLayout(context).apply{orientation=LinearLayout.VERTICAL;setPadding(14,10,14,10);setBackgroundColor(background);addView(first,LinearLayout.LayoutParams(-1,-2));addView(second,LinearLayout.LayoutParams(-1,-2));addView(toolbar,LinearLayout.LayoutParams(-1,-2))}
            arrange(rows,520)
            val path=File("build/reports/lyric-previews/android-lyrics-$name.png");path.parentFile.mkdirs()
            path.outputStream().use{pixels(rows).compress(Bitmap.CompressFormat.PNG,100,it)}
            toolbar.getChildAt(2).performClick()
            assertEquals(FloatingLyricsToolbar.Action.LOCK,actions.last())
        }
    }
}
