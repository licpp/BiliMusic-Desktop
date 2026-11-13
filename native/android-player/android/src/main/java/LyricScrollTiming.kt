package app.bilimusic.player

// Match lyricTimeline.ts: hold both ends long enough to read, then follow the
// media/word clock. Short lines reserve a proportion instead of fixed delays.
internal object LyricScrollTiming {
    data class Window(val startAt: Double,val endAt: Double) {
        fun position(time: Double,progress: Double,from: Double,to: Double): Float {
            if(time<=startAt)return 0f
            if(time>=endAt)return 1f
            return (if(to-from>1e-6)(progress-from)/(to-from) else (time-startAt)/(endAt-startAt)).coerceIn(0.0,1.0).toFloat()
        }
    }
    fun window(start: Double,end: Double,viewport: Double,width: Double,firstDuration: Double=0.0,lastDuration: Double=0.0): Window? {
        if(width<=viewport || viewport<=0)return null
        val duration=(end-start).coerceAtLeast(1.0)
        val visibleDuration=duration*minOf(1.0,viewport/width)
        val lead=minOf(duration*.18,maxOf(180.0,minOf(650.0,maxOf(visibleDuration*.12,firstDuration.coerceAtLeast(0.0)*.35))))
        val tail=minOf(duration*.22,maxOf(240.0,minOf(850.0,maxOf(visibleDuration*.16,lastDuration.coerceAtLeast(0.0)*.45))))
        return Window(start+lead,end-tail)
    }
}
