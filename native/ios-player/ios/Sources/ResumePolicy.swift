import Foundation

struct AutomaticResumePolicy: Codable {
    let enabled: Bool
    let thresholdSeconds: Double
    let collection: Bool
    let durationSeconds: Double
}

enum ResumePositionError: LocalizedError {
    case missingDuration
    var errorDescription: String? { "无法读取视频总时长，请重新播放" }
}

func playbackStartPosition(_ position: Double, duration: Double, policy: AutomaticResumePolicy?) throws -> Double {
    guard position.isFinite, position >= 0 else { return 0 }
    guard let policy else { return position }
    let total = duration.isFinite && duration > 0 ? duration : policy.durationSeconds
    if position >= 1 && policy.enabled && policy.thresholdSeconds > 0 && !(total.isFinite && total > 0) { throw ResumePositionError.missingDuration }
    let resume = policy.enabled && (policy.thresholdSeconds <= 0 || total.isFinite && total >= policy.thresholdSeconds)
    return resume && position >= 1 && (!total.isFinite || total <= 0 || position < total - 1) ? position : 0
}
