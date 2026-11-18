package app.bilimusic.player

import org.json.JSONArray
import org.json.JSONObject

/** Queue state belongs to the service, including while the WebView is suspended. */
internal class NativeQueue {
    var accountSession = ""
        private set
    var version = 0L
        private set
    var owner = ""
        private set
    private val retiredOwners = mutableSetOf<String>()
    var tracks: List<JSONObject> = emptyList()
        private set
    val expanded = JSONObject()
    private var repeatMode = "off"
    private val shuffle = ShuffleDeck()
    private var shuffled = false
    private var autoResume = true
    private var threshold = 0.0
    private var origins = JSONObject()
    private var entryOrder: List<String> = emptyList()
    private var offlineOnly = false
    private var collection = false
    var collectionRef: String? = null
        private set

    fun update(data: JSONObject) {
        val nextOwner = data.optString("owner", "legacy")
        if (nextOwner in retiredOwners) return
        val nextVersion = data.optLong("version", if (nextOwner == owner) version+1 else 1)
        if (nextOwner == owner && nextVersion <= version) return
        val items = data.getJSONArray("tracks")
        require(items.length() <= 10000 && data.getString("repeatMode") in listOf("off", "one", "all"))
        val incoming = (0 until items.length()).map { items.getJSONObject(it) }
        require(incoming.all { it.optString("id").isNotEmpty() && it.optJSONObject("source") != null })
        val nextSession = data.optString("accountSession")
        if (nextOwner != owner) { if (owner.isNotEmpty()) retiredOwners.add(owner); owner=nextOwner }
        version=nextVersion
        if (nextSession != accountSession) expanded.keys().asSequence().toList().forEach { expanded.remove(it) }
        if(nextSession != accountSession || shuffled != data.optBoolean("shuffled")) shuffle.reset()
        accountSession=nextSession
        val keep = incoming.filter { it.optBoolean("resolveParts") }.map { it.getString("id") }.toSet()
        expanded.keys().asSequence().toList().filter { it !in keep }.forEach { expanded.remove(it) }
        tracks = incoming.flatMap { item ->
            val parts = expanded.optJSONArray(item.getString("id"))
            if (parts != null && item.optBoolean("resolveParts")) (0 until parts.length()).map { parts.getJSONObject(it) } else listOf(item)
        }.distinctBy { it.getString("id") }
        origins = data.optJSONObject("entryOrigins") ?: JSONObject()
        val order = data.optJSONArray("entryOrder")
        entryOrder = (if (order != null) (0 until order.length()).map { order.getString(it) } else incoming.map { it.getString("id") }).flatMap { id ->
            val parts=expanded.optJSONArray(id)
            if(parts!=null) (0 until parts.length()).map { parts.getJSONObject(it).getString("id") } else listOf(id)
        }
        for (entry in expanded.keys().asSequence().toList()) {
            val inherited=origins.optJSONArray(entry) ?: JSONArray()
            val parts=expanded.optJSONArray(entry) ?: continue
            for (i in 0 until parts.length()) {val part=parts.getJSONObject(i).getString("id");if(!origins.has(part)) origins.put(part,inherited)}
        }
        offlineOnly = data.optBoolean("offlineOnly")
        repeatMode = data.getString("repeatMode"); shuffled = data.optBoolean("shuffled")
        autoResume = data.optBoolean("autoResume", true); threshold = data.optDouble("resumeThresholdSeconds", 0.0)
        collection = data.optBoolean("collectionPlayback"); collectionRef = data.optString("collectionRef").takeIf { it.isNotEmpty() }
    }
    fun find(id: String) = tracks.firstOrNull { it.optString("id") == id }
    fun target(id: String, direction: Int, ended: Boolean): JSONObject? {
        if (tracks.isEmpty()) return null
        val index = tracks.indexOfFirst { it.optString("id") == id }
        if (ended && repeatMode == "one" && index >= 0) return find(id)
        if (ended && !shuffled && repeatMode == "off" && index == tracks.lastIndex) return null
        if(shuffled) return find(shuffle.target(shuffleItems(),id,direction) ?: "")
        val visible=tracks.map { it.getString("id") }
        val sequence=if(index>=0)visible else entryOrder
        val sourceIndex=sequence.indexOf(id)
        if(sourceIndex<0)return if(direction>0)tracks.first() else tracks.last()
        val candidates=if(direction>0)sequence.drop(sourceIndex+1) else sequence.take(sourceIndex).reversed()
        return candidates.firstNotNullOfOrNull { find(it) } ?: if(!ended || repeatMode=="all") (if(direction>0)tracks.first() else tracks.last()) else null
    }
    private fun shuffleItems() = tracks.map { ShuffleItem(it.getString("id"),it.optString("artist"),it.optJSONObject("source")?.optString("bvid") ?: "") }
    fun observe(id:String) { if(shuffled) shuffle.observe(shuffleItems(),id) }
    fun restart(ended: Boolean) = ended && repeatMode == "one"
    fun payload(profile: String, track: JSONObject, restart: Boolean, refresh: Boolean, position: Double?): JSONObject {
        val source = track.getJSONObject("source")
        val isCollection = collection || track.optInt("partCount") > 1 || source.optInt("page") > 1 ||
            tracks.any { it.optString("id") != track.optString("id") && it.optJSONObject("source")?.optString("bvid") == source.optString("bvid") }
        return JSONObject().put("accountSession", accountSession.takeIf { it.isNotEmpty() }).put("profile", profile).put("track", track).put("restart", restart)
            .put("offlineOnly", offlineOnly).put("refresh", refresh).put("position", position).put("autoResume", autoResume)
            .put("resumeThresholdSeconds", threshold).put("collectionPlayback", isCollection).put("visibilityScopes", origins.optJSONArray(track.optString("id")) ?: JSONArray())
    }
    fun skip(entry: String): JSONObject? {
        val index = tracks.indexOfFirst { it.optString("id") == entry }
        tracks = tracks.filter { it.optString("id") != entry }
        expanded.remove(entry)
        return if (tracks.isEmpty() || index >= tracks.size && repeatMode != "all") null else tracks[if(index >= tracks.size) 0 else index.coerceAtLeast(0)]
    }
    fun resolved(result: JSONObject) {
        val parts = result.optJSONArray("parts") ?: return
        val entry = result.optString("entryId")
        if (parts.length() == 0 || find(entry)?.optBoolean("resolveParts") != true) return
        val inherited = origins.optJSONArray(entry) ?: JSONArray()
        for (i in 0 until parts.length()) origins.put(parts.getJSONObject(i).getString("id"), inherited)
        expanded.put(entry, parts)
        entryOrder = entryOrder.flatMap { if(it==entry) (0 until parts.length()).map { i -> parts.getJSONObject(i).getString("id") } else listOf(it) }
        tracks = tracks.flatMap { if (it.optString("id") == entry) (0 until parts.length()).map { i -> parts.getJSONObject(i) } else listOf(it) }
            .distinctBy { it.getString("id") }
    }
}
