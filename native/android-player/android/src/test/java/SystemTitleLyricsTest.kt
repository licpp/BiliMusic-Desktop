package app.bilimusic.player

import android.content.Context
import org.robolectric.RuntimeEnvironment
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SystemTitleLyricsTest {
    @Test fun lyricFollowsClockBiasGapsAndTrackIdentityInEitherMode() {
        val context = RuntimeEnvironment.getApplication()
        assertEquals("歌词",lyricDisplayText("🎵歌词♪♫🎶"))
        SystemTitleLyrics.configure(context, false)
        SystemTitleLyrics.update(JSONObject("""{"id":"a","subtitles":true,"biasMs":500,"lines":[{"timeMs":1000,"endTimeMs":2000,"text":"♪ 第一行 ♫"},{"timeMs":4000,"text":"下一句"}]}"""))
        assertEquals("第一行",SystemTitleLyrics.line("a",1.5))
        assertEquals(SystemMediaText("歌名", "第一行"),SystemTitleLyrics.mediaText("歌名","歌手",SystemTitleLyrics.line("a",1.5)))
        SystemTitleLyrics.configure(context,true)
        SystemTitleLyrics.attach(context)
        assertNull(SystemTitleLyrics.line("a",1.499))
        assertEquals("第一行",SystemTitleLyrics.line("a",1.5))
        assertNull(SystemTitleLyrics.line("a",2.5))
        assertNull(SystemTitleLyrics.line("b",4.5))
        assertEquals("下一句",SystemTitleLyrics.line("a",4.5))
        assertEquals(SystemMediaText("下一句", "歌手"),SystemTitleLyrics.mediaText("歌名","歌手",SystemTitleLyrics.line("a",4.5)))
        SystemTitleLyrics.configure(context,false)
        assertEquals("下一句",SystemTitleLyrics.line("a",4.5))
    }
}
