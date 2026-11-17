package app.bilimusic.player

// Renders the Rust gain plan; does not decide LUFS targets or measure audio.
class OutputGain {
    private var enabled = false
    private var revision = -1L
    private var gainDb = 0.0
    private var from = 0.0
    private var target = 0.0
    private var began = 0L
    fun configure(value: Boolean, version: Long): Boolean {
        if (version < revision) return false
        enabled = value; revision = version; return true
    }
    fun plan(db: Double) { gainDb = if (db.isFinite()) db.coerceIn(-80.0, 0.0) else 0.0 }
    fun current(now: Long): Double = from + (target - from) * ((now - began) / 300.0).coerceIn(0.0, 1.0)
    fun transition(now: Long, smooth: Boolean) { val next = if (enabled) gainDb else 0.0; from = if (smooth) current(now) else next; target = next; began = now }
    fun active(now: Long): Boolean = now < began + 300 && from != target
    fun level(volume: Float, duck: Float, now: Long): Float = (volume.coerceIn(0f,1f) * Math.pow(10.0, current(now) / 20.0) * duck.coerceIn(0f,1f)).toFloat()
}
