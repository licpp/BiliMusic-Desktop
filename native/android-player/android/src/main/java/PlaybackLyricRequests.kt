package app.bilimusic.player

/** A network reply belongs to a logical play and to the latest lyric choice. */
internal class PlaybackLyricRequests {
    private data class Lookup(val serial: Long, val session: String, val profile: String, val account: String)
    private var serial = 0L
    private var latest: Lookup? = null

    fun start(session: String, profile: String, account: String): Long {
        val next = ++serial
        latest = Lookup(next, session, profile, account)
        return next
    }

    fun take(serial: Long, session: String, profile: String?, account: String): Boolean {
        val lookup = latest ?: return false
        if (lookup.serial != serial || lookup.session != session || lookup.profile != profile || lookup.account != account) return false
        latest = null
        return true
    }

    fun supersede() {
        latest = null
    }
}
