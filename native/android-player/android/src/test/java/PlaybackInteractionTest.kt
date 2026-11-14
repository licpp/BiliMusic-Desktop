package app.bilimusic.player

import android.view.KeyEvent
import org.junit.Assert.*
import org.junit.Test

class PlaybackInteractionTest {
    @Test fun unlockButtonCanBeHiddenWithoutChangingTheLockOrTouchThroughPolicy() {
        assertTrue(FloatingLyricsWindowPolicy.showUnlock(true,true,true,true))
        assertFalse(FloatingLyricsWindowPolicy.showUnlock(true,true,false,true))
        assertFalse(FloatingLyricsWindowPolicy.showUnlock(true,false,true,true))
        assertFalse(FloatingLyricsWindowPolicy.showUnlock(false,true,true,true))
        assertFalse(FloatingLyricsWindowPolicy.showUnlock(true,true,true,false))
        assertEquals(.8f,FloatingLyricsWindowPolicy.alpha(true,36,.8f),.0001f)
    }

    @Test fun transientInterruptionsResumeOnceAndExplicitPauseCancelsRecovery() {
        val resume = FocusResume()
        resume.interrupted(true)
        resume.interrupted(false)
        assertTrue(resume.regained())
        assertFalse(resume.regained())
        resume.interrupted(true); resume.cancel(); assertFalse(resume.regained())
        resume.interrupted(false); assertFalse(resume.regained())
    }
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
    @Test fun scrollingLeavesTimeToReadBothEdgesAndScalesForShortLines() {
        val window=LyricScrollTiming.window(1000.0,5000.0,400.0,800.0)!!
        assertEquals(1240.0,window.startAt,.0001);assertEquals(4680.0,window.endAt,.0001)
        assertEquals(0f,window.position(1200.0,.05,.06,.92),.0001f)
        assertEquals(.5f,window.position(3000.0,.49,.06,.92),.0001f)
        assertEquals(1f,window.position(4900.0,.975,.06,.92),.0001f)
        val short=LyricScrollTiming.window(0.0,200.0,300.0,600.0)!!
        assertEquals(36.0,short.startAt,.0001);assertEquals(156.0,short.endAt,.0001)
        assertNull(LyricScrollTiming.window(0.0,2000.0,600.0,600.0))
        assertNull(LyricScrollTiming.window(0.0,2000.0,0.0,600.0))
    }
    @Test fun scrollingReadingHoldsUseViewportAndEdgeWordDuration() {
        val narrow=LyricScrollTiming.window(0.0,4000.0,200.0,1000.0)!!
        val wide=LyricScrollTiming.window(0.0,4000.0,800.0,1000.0)!!
        assertTrue(wide.startAt>narrow.startAt);assertTrue(wide.endAt<narrow.endAt)
        val words=LyricScrollTiming.window(0.0,4000.0,200.0,1000.0,1500.0,1500.0)!!
        assertTrue(words.startAt>narrow.startAt);assertTrue(words.endAt<narrow.endAt)
    }
    @Test fun scrollingHoldsTimedGapsAndInterpolatesIfBothEdgesFallInOneGap() {
        val window=LyricScrollTiming.window(0.0,6000.0,300.0,600.0)!!
        assertEquals(window.position(2500.0,.5,.06,.94),window.position(3500.0,.5,.06,.94),.0001f)
        val halfway=(window.startAt+window.endAt)/2
        assertEquals(.5f,window.position(halfway,.5,.5,.5),.0001f)
        assertEquals(0f,window.position(0.0,0.0,.5,.5),.0001f)
        assertEquals(1f,window.position(6000.0,1.0,.5,.5),.0001f)
    }
    @Test fun lyricControlsAppearOnlyAfterTappingAndExpireWithoutMovingRows() {
        val controls=FloatingLyricsControls()
        assertFalse(controls.visible(0,false))
        controls.reveal(100)
        assertTrue(controls.visible(100,false));assertTrue(controls.visible(4099,false))
        assertFalse(controls.visible(4100,false));assertFalse(controls.visible(200,true))
        controls.reveal(4000);assertTrue(controls.visible(4100,false))
        controls.hide();assertFalse(controls.visible(4200,false))
    }
    @Test fun unlockButtonIsBoundedAndOutsideThePassThroughLyrics() {
        for((width,height)in listOf(1080 to 2400,2400 to 1080))for(y in listOf(0,height/2,height-160)) {
            val (x,top)=FloatingLyricsWindowPolicy.unlockPosition(30,y,width-60,160,width,height,44,2)
            assertTrue(x>=0 && x+44<=width);assertTrue(top>=0 && top+44<=height)
            assertTrue(top+44<=y || top>=y+160)
        }
    }
}
