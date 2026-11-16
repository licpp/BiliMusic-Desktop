package app.bilimusic.player

import android.content.Context
import org.robolectric.RuntimeEnvironment
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SystemTitleLyricsTest {
    @Test fun optionalTitleFollowsClockBiasGapsAndTrackIdentity() {
        val context = RuntimeEnvironment.getApplication()
        assertEquals("歌词",lyricDisplayText("🎵歌词♪♫🎶"))
        SystemTitleLyrics.configure(context, false)
        SystemTitleLyrics.update(JSONObject("""{"id":"a","subtitles":true,"biasMs":500,"lines":[{"timeMs":1000,"endTimeMs":2000,"text":"♪ 第一行 ♫"},{"timeMs":4000,"text":"下一句"}]}"""))
        assertEquals("歌名",SystemTitleLyrics.title("a",1.5,"歌名"))
        SystemTitleLyrics.configure(context,true)
        SystemTitleLyrics.attach(context)
        assertEquals("歌名",SystemTitleLyrics.title("a",1.499,"歌名"))
        assertEquals("第一行",SystemTitleLyrics.title("a",1.5,"歌名"))
        assertEquals("歌名",SystemTitleLyrics.title("a",2.5,"歌名"))
        assertEquals("歌名",SystemTitleLyrics.title("b",4.5,"歌名"))
        assertEquals("下一句",SystemTitleLyrics.title("a",4.5,"歌名"))
        SystemTitleLyrics.configure(context,false)
        assertEquals("歌名",SystemTitleLyrics.title("a",4.5,"歌名"))
    }
}
