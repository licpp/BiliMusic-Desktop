package app.bilimusic.player
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import org.json.JSONArray

@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk=[28],manifest=org.robolectric.annotation.Config.NONE)
class OutputGainTest {
    @Test fun rendersSharedPlansWithinPlayerHeadroomBeforeDucking() {
        val root=generateSequence(File("").absoluteFile){it.parentFile}.first { File(it,"tests/fixtures/loudness.json").exists() }
        val rows=JSONArray(File(root,"tests/fixtures/loudness.json").readText())
        for(i in 0 until rows.length()) {
            val db=rows.getJSONObject(i).getDouble("gainDb")
            val gain=OutputGain();gain.configure(true,1);gain.plan(db);gain.transition(0,false)
            for(volume in listOf(0f,.2f,.7f,.9f,1f)) {
                val expected=(volume*Math.pow(10.0,db/20)).coerceAtMost(1.0).toFloat()
                assertEquals(expected,gain.level(volume,1f,0),0.000001f)
                assertEquals(expected*.2f,gain.level(volume,.2f,0),0.000001f)
            }
        }
    }
    @Test fun smoothToggleRejectsStaleSettingsAndNewTrackResetsGain() {
        val gain=OutputGain();gain.configure(true,2);gain.plan(-12.0);gain.transition(0,true)
        assertEquals(-6.0,gain.current(150),0.000001)
        assertFalse(gain.configure(false,1))
        gain.transition(300,false);assertEquals(-12.0,gain.current(300),0.000001)
        gain.configure(false,3);gain.transition(300,true);assertEquals(-6.0,gain.current(450),0.000001)
        gain.configure(true,4);gain.plan(0.0);gain.transition(450,false);assertEquals(.7f,gain.level(.7f,1f,450),0.000001f)
        for(db in listOf(Double.NaN,Double.POSITIVE_INFINITY,Double.NEGATIVE_INFINITY,9.0)){gain.plan(db);gain.transition(500,false);assertEquals(1f,gain.level(1f,1f,500),0f)}
    }
}
