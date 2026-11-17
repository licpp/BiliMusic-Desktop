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
        for (index in 0..1) assertNotEquals("2", queue(shuffled = true).target("2", 1, true)!!.getString("id"))
    }
    @Test fun portableShuffleFixtureMatchesDesktopSwiftAndHarmony() {
        val root=generateSequence(java.io.File(System.getProperty("user.dir"))) { it.parentFile }.first { java.io.File(it,"tests/fixtures/shuffle.json").exists() }
        val fixture=JSONObject(java.io.File(root,"tests/fixtures/shuffle.json").readText())
        val rows=fixture.getJSONArray("items")
        val items=(0 until rows.length()).map { val item=rows.getJSONObject(it);ShuffleItem(item.getString("id"),item.getString("artist"),item.getString("bvid")) }
        var seed=fixture.getLong("seed")
        val deck=ShuffleDeck { seed=(seed*1664525+1013904223) and 0xffffffffL;seed.toDouble()/4294967296.0 }
        val operations=fixture.getJSONArray("operations")
        for(i in 0 until operations.length()) {
            val op=operations.getJSONObject(i);val ids=op.getJSONArray("ids");val selected=(0 until ids.length()).map{ids.getString(it)}.toSet()
            val queue=items.filter{it.id in selected};val current=op.getString("current")
            if(i==35)deck.observe(queue,current)
            assertEquals("operation $i",op.getString("result"),deck.target(queue,current,op.getInt("direction")))
        }
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

    @Test fun visibilityOriginsSurviveLazyExpansionAndSkipTerminates() {
        val q=NativeQueue();val entry=track("entry").put("resolveParts",true)
        val data=JSONObject().put("tracks",JSONArray(listOf(entry,track("3")))).put("repeatMode","off").put("entryOrigins",JSONObject().put("entry",JSONArray(listOf("season:1:2"))).put("3",JSONArray(listOf(""))))
        q.update(data);q.resolved(JSONObject().put("entryId","entry").put("parts",JSONArray(listOf(track("1"),track("2")))))
        assertEquals("season:1:2",q.payload("42",q.find("1")!!,false,false,null).getJSONArray("visibilityScopes").getString(0))
        q.update(data)
        assertEquals("season:1:2",q.payload("42",q.find("2")!!,false,false,null).getJSONArray("visibilityScopes").getString(0))
        assertEquals("",q.payload("42",q.find("3")!!,false,false,null).getJSONArray("visibilityScopes").getString(0))
        assertEquals("2",q.skip("1")!!.getString("id"));assertEquals("3",q.skip("2")!!.getString("id"));assertNull(q.skip("3"));assertTrue(q.tracks.isEmpty())
    }
    @Test fun hiddenAudibleOrderMatchesThePortableFixture() {
        val root=generateSequence(java.io.File(System.getProperty("user.dir"))) { it.parentFile }.first { java.io.File(it,"tests/fixtures/queue-visibility-order.json").exists() }
        val cases=JSONArray(java.io.File(root,"tests/fixtures/queue-visibility-order.json").readText())
        for(i in 0 until cases.length()) {
            val item=cases.getJSONObject(i);val visible=item.getJSONArray("visible")
            val q=NativeQueue();q.update(JSONObject().put("entryOrder",item.getJSONArray("order")).put("tracks",JSONArray((0 until visible.length()).map { track(visible.getString(it)) })).put("repeatMode",item.getString("repeat")))
            val actual=q.target(item.getString("current"),item.getInt("direction"),item.getBoolean("ended"))?.getString("id")
            assertEquals("case $i",if(item.isNull("result")) null else item.getString("result"),actual)
        }
    }
}
