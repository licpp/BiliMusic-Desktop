import Foundation

struct Source: Codable {
    let provider: String; let bvid: String; let cid: Int64; let page: Int
    let aid: Int64?; let uploaderId: Int64?; let uploaderName: String?
}
struct QueueTrack: Codable {
    let id: String; let source: Source
    var title: String; var artist: String?; var album: String?; var coverUrl: String?
    var displayTitle: String?; var chapterContext: Bool?; var publishedAt: Int64?; var playCount: Int64?
    var durationSeconds: Double; var liked: Bool?; var resolveParts: Bool?; var videoTitle: String?; var partCount: Int?
}
struct PlaybackCapabilities: Encodable { var autonomousQueue = false; var seamlessSourceSwitch = true; var nativeSleepTimer = true; var snapshotRebind = true }
struct PlayerSnapshot: Encodable {
    var capabilities = PlaybackCapabilities()
    var engineInstanceId = ""
    var sessionId = ""
    var sourceRevision: Int64 = 0
    var autonomousQueue = false
    var queueVersion: Int64 = 0
    var id: String?
    var status = "paused"
    var rate: Double = 1
    var position: Double = 0
    var duration: Double = 0
    var stopped = true
    var floatingLyricsEnabled = false
    var error: String?
    var track: QueueTrack?
    var revision: Int64 = 0
    var sequence: Int64 = 0
    var seekRevision = 0
    var advancing = false
    var recoveryAttempted = false
    var expandedEntries: [String: [QueueTrack]]?
    var sleepDeadline: Double = 0
    var sleepDuration: Double = 0
    var sleepExpired = false
}
