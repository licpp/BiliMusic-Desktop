package app.bilimusic.player

import android.view.KeyEvent
import org.junit.Assert.*
import org.junit.Test

class PlaybackInteractionTest {
    @Test fun headsetAndMediaKeysHaveOneActionPerPress() {
        val keys=mapOf(KeyEvent.KEYCODE_HEADSETHOOK to "toggle",KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "toggle",KeyEvent.KEYCODE_MEDIA_NEXT to "next",KeyEvent.KEYCODE_MEDIA_PREVIOUS to "previous",KeyEvent.KEYCODE_MEDIA_PLAY to "resume",KeyEvent.KEYCODE_MEDIA_PAUSE to "pause",KeyEvent.KEYCODE_MEDIA_STOP to "stop")
        for((key,action) in keys) {
            assertTrue(MediaButtons.supports(key));assertEquals(action,MediaButtons.action(key,true,0))
            assertNull(MediaButtons.action(key,false,0));assertNull(MediaButtons.action(key,true,1))
        }
        assertFalse(MediaButtons.supports(KeyEvent.KEYCODE_VOLUME_UP))
        assertNull(MediaButtons.action(KeyEvent.KEYCODE_VOLUME_UP,true,0))
    }
    @Test fun lockedOverlayHonorsTheSystemTouchThroughOpacityLimit() {
        assertEquals(.8f,FloatingLyricsWindowPolicy.alpha(true,31,.8f),.0001f)
        assertEquals(.65f,FloatingLyricsWindowPolicy.alpha(true,36,.65f),.0001f)
        assertEquals(.8f,FloatingLyricsWindowPolicy.alpha(true,36,1f),.0001f)
        assertEquals(1f,FloatingLyricsWindowPolicy.alpha(false,36,.8f),.0001f)
        assertEquals(1f,FloatingLyricsWindowPolicy.alpha(true,30,.8f),.0001f)
    }
    @Test fun unlockStaysVisibleAboveOrBelowLyricsAndInsideScreenEdges() {
        for((w,h) in listOf(1080 to 2400,2400 to 1080,320 to 240)) {
            val size=44;val gap=6;val height=90;val width=(w*.9).toInt()
            for(y in listOf(0,h/2,(h-height).coerceAtLeast(0))) {
                val(x,top)=FloatingLyricsWindowPolicy.unlockPosition(20,y,width,height,w,h,size,gap)
                assertTrue(x>=0&&x+size<=w);assertTrue(top>=0&&top+size<=h)
                assertTrue(top+size<=y || top>=y+height)
            }
        }
        assertEquals(0 to 0,FloatingLyricsWindowPolicy.unlockPosition(-100,-100,20,20,30,30,44,6))
    }
}
