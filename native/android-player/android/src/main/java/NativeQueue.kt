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
    private var shuffled = false
    private var autoResume = true
    private var threshold = 0.0
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
        accountSession=nextSession
        val keep = incoming.filter { it.optBoolean("resolveParts") }.map { it.getString("id") }.toSet()
        expanded.keys().asSequence().toList().filter { it !in keep }.forEach { expanded.remove(it) }
        tracks = incoming.flatMap { item ->
            val parts = expanded.optJSONArray(item.getString("id"))
            if (parts != null && item.optBoolean("resolveParts")) (0 until parts.length()).map { parts.getJSONObject(it) } else listOf(item)
        }.distinctBy { it.getString("id") }
        repeatMode = data.getString("repeatMode"); shuffled = data.optBoolean("shuffled")
        autoResume = data.optBoolean("autoResume", true); threshold = data.optDouble("resumeThresholdSeconds", 0.0)
        collection = data.optBoolean("collectionPlayback"); collectionRef = data.optString("collectionRef").takeIf { it.isNotEmpty() }
    }
    fun find(id: String) = tracks.firstOrNull { it.optString("id") == id }
    fun target(id: String, direction: Int, ended: Boolean, random: (Int) -> Int = { kotlin.random.Random.nextInt(it) }): JSONObject? {
        if (tracks.isEmpty()) return null
        val index = tracks.indexOfFirst { it.optString("id") == id }
        if (ended && repeatMode == "one") return find(id)
        if (ended && !shuffled && repeatMode == "off" && index == tracks.lastIndex) return null
        val target = if (shuffled && tracks.size > 1) (maxOf(0, index) + 1 + random(tracks.size - 1)) % tracks.size
            else Math.floorMod(index + direction, tracks.size)
        return tracks[target]
    }
    fun restart(ended: Boolean) = ended && repeatMode == "one"
    fun payload(profile: String, track: JSONObject, restart: Boolean, refresh: Boolean, position: Double?): JSONObject {
        val source = track.getJSONObject("source")
        val isCollection = collection || track.optInt("partCount") > 1 || source.optInt("page") > 1 ||
            tracks.any { it.optString("id") != track.optString("id") && it.optJSONObject("source")?.optString("bvid") == source.optString("bvid") }
        return JSONObject().put("accountSession", accountSession.takeIf { it.isNotEmpty() }).put("profile", profile).put("track", track).put("restart", restart)
            .put("refresh", refresh).put("position", position).put("autoResume", autoResume)
            .put("resumeThresholdSeconds", threshold).put("collectionPlayback", isCollection)
    }
    fun resolved(result: JSONObject) {
        val parts = result.optJSONArray("parts") ?: return
        val entry = result.optString("entryId")
        if (parts.length() == 0 || find(entry)?.optBoolean("resolveParts") != true) return
        expanded.put(entry, parts)
        tracks = tracks.flatMap { if (it.optString("id") == entry) (0 until parts.length()).map { i -> parts.getJSONObject(i) } else listOf(it) }
            .distinctBy { it.getString("id") }
    }
}
