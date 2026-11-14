package app.bilimusic.player

internal class FocusResume {
    private var pending = false
    fun interrupted(wasPlaying: Boolean) { pending = pending || wasPlaying }
    fun cancel() { pending = false }
    fun regained(): Boolean {
        val resume = pending
        pending = false
        return resume
    }
}
