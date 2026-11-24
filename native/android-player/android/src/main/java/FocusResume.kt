package app.bilimusic.player

internal class FocusResume {
    var pending = false
        private set
    fun interrupted(wasPlaying: Boolean) { pending = pending || wasPlaying }
    fun cancel() { pending = false }
    fun regained(): Boolean {
        val resume = pending
        pending = false
        return resume
    }
}
