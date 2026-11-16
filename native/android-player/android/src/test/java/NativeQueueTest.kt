package app.bilimusic.player

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class NativeQueueTest {
    private fun track(id: String, bvid: String = "BV$id", page: Int = 1) = JSONObject().put("id", id)
        .put("source", JSONObject().put("bvid", bvid).put("page", page))
    private fun queue(repeat: String = "off", shuffled: Boolean = false) = NativeQueue().apply {
        update(JSONObject().put("tracks", JSONArray(listOf(track("1"), track("2"), track("3"))))
            .put("repeatMode", repeat).put("shuffled", shuffled))
    }
    @Test fun sequentialManualRepeatAndShuffleMatchTheAppQueue() {
        val q = queue()
        assertEquals("2", q.target("1", 1, true)!!.getString("id"))
        assertNull(q.target("3", 1, true))
        assertEquals("1", q.target("3", 1, false)!!.getString("id"))
        assertEquals("3", q.target("1", -1, false)!!.getString("id"))
        assertEquals("1", queue("all").target("3", 1, true)!!.getString("id"))
        assertEquals("2", queue("one").target("2", 1, true)!!.getString("id"))
        assertEquals("3", queue("one").target("2", 1, false)!!.getString("id"))
        for (index in 0..1) assertNotEquals("2", queue(shuffled = true).target("2", 1, true) { index }!!.getString("id"))
    }
    @Test fun collectionExpansionDeduplicatesAndSurvivesAnOldWebViewQueue() {
        val q = NativeQueue(); val entry = track("entry").put("resolveParts", true)
        val data = JSONObject().put("tracks", JSONArray(listOf(entry, track("3")))).put("repeatMode", "all")
        q.update(data)
        q.resolved(JSONObject().put("entryId", "entry").put("parts", JSONArray(listOf(track("1"), track("2"), track("2")))))
        q.update(data)
        assertEquals(listOf("1", "2", "3"), q.tracks.map { it.getString("id") })
        assertEquals("2", q.target("1", 1, true)!!.getString("id"))
    }
    @Test fun payloadPreservesCheckpointPolicyAndExplicitRecoveryPosition() {
        val q = queue()
        val data = JSONObject().put("tracks", JSONArray(listOf(track("1", "BV", 1), track("2", "BV", 2))))
            .put("repeatMode", "all").put("autoResume", false).put("collectionRef", "BV")
        q.update(data)
        val payload = q.payload("account", q.find("1")!!, false, true, 23.5)
        assertTrue(payload.getBoolean("collectionPlayback")); assertFalse(payload.getBoolean("autoResume"))
        assertEquals(23.5, payload.getDouble("position"), 0.0); assertEquals("BV", q.collectionRef)
        val single = queue().payload("account", track("1"), false, false, null)
        assertFalse(single.getBoolean("collectionPlayback")); assertTrue(single.isNull("position"))
    }
    @Test fun invalidMirrorsDoNotRetireOwnersAndOlderOwnersCannotOverwriteNewMirrors() {
        val q=NativeQueue()
        fun data(owner:String,version:Long)=JSONObject().put("owner",owner).put("version",version)
            .put("accountSession","account").put("repeatMode","off").put("tracks",JSONArray(listOf(track("1"))))
        q.update(data("a",4))
        try { q.update(data("broken",1).put("tracks",JSONArray(listOf(JSONObject())))); fail("Expected rejection") } catch (_: IllegalArgumentException) {}
        assertEquals("a",q.owner);assertEquals(4L,q.version)
        q.update(data("b",1));q.update(data("a",99))
        assertEquals("b",q.owner);assertEquals(1L,q.version)
    }
}
