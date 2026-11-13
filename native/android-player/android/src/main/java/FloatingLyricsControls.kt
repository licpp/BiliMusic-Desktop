package app.bilimusic.player

internal class FloatingLyricsControls(private val timeout: Long=4000L) {
    private var until=0L
    fun reveal(now: Long){until=now+timeout}
    fun hide(){until=0L}
    fun visible(now: Long,locked: Boolean)=!locked && now<until
}
