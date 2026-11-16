package app.bilimusic.player

import app.tauri.annotation.InvokeArg

@InvokeArg
class AutomaticResumePolicy {
    var enabled: Boolean = true
    var thresholdSeconds: Double = 0.0
    var collection: Boolean = false
    var durationSeconds: Double = 0.0
}

internal fun playbackStartPosition(position: Double, duration: Double, policy: AutomaticResumePolicy?): Double {
    if (!position.isFinite() || position < 0) return 0.0
    if (policy == null) return position
    val total = if (duration.isFinite() && duration > 0) duration else policy.durationSeconds
    check(!(position >= 1 && policy.enabled && policy.thresholdSeconds > 0 && !(total.isFinite() && total > 0))) { "无法读取视频总时长，请重新播放" }
    val resume = policy.enabled && (policy.thresholdSeconds <= 0 || total.isFinite() && total >= policy.thresholdSeconds)
    return if (resume && position >= 1 && (!total.isFinite() || total <= 0 || position < total - 1)) position else 0.0
}
