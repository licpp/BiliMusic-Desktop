import Foundation

struct NativeLyricLine: Decodable {
    let timeMs: Double; let endTimeMs: Double?; let text: String
}
struct NativeLyricsRequest: Decodable {
    var enabled: Bool? = nil
    let action: String; let id: String?; let lines: [NativeLyricLine]?; let biasMs: Double?; let subtitles: Bool?
}
struct NativeSavedLyrics: Decodable {
    let lines: [NativeLyricLine]; let biasMs: Double

    private enum CodingKeys: String, CodingKey { case lines, biasMs }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        lines = (try? values.decode([NativeLyricLine].self, forKey: .lines)) ?? []
        biasMs = (try? values.decode(Double.self, forKey: .biasMs)) ?? 0
    }
}
struct LyricsArgs: Decodable { let data: String }
struct LyricsCapability: Encodable {
    var supported = true; var enabled = true
    var fontSizeSupported = false; var lockSupported = false; var colorSupported = false
}

// The native audio clock keeps notification lyrics advancing while WebKit is
// suspended. This owns lyric data only; it never starts another media session.
final class NotificationLyrics {
    private var request: NativeLyricsRequest?
    private var saved: NativeLyricsRequest?
    func update(_ value: NativeLyricsRequest) { request=value }
    func seed(_ value: NativeLyricsRequest) { saved=value }
    func clear() { request=nil; saved=nil }
    func line(for trackID: String?, at position: Double, carAudio: Bool = false) -> String? {
        guard !carAudio, let trackID, !trackID.isEmpty, position.isFinite else { return nil }
        let live = request?.id == trackID && request?.lines?.isEmpty == false ? request : nil
        guard let request = live ?? saved, request.id == trackID, let lines = request.lines else { return nil }
        let time=position*1000-(request.biasMs ?? 0)
        var low=0,high=lines.count
        while low<high { let mid=(low+high)/2; if lines[mid].timeMs<=time { low=mid+1 } else { high=mid } }
        guard low>0 else { return nil }
        let current=lines[low-1]
        // Subtitle cues have real gaps; ordinary lyrics hold until the next line.
        if request.subtitles == true,let end=current.endTimeMs,position*1000-(request.biasMs ?? 0)>=end { return nil }
        let text=current.text.replacingOccurrences(of:"[♪♫♬♩🎵🎶]",with:"",options:.regularExpression).components(separatedBy:.newlines).joined(separator:" ").trimmingCharacters(in:.whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}

func notificationMediaText(title: String, artist: String, lyric: String?) -> (title: String, artist: String) {
    (title, lyric ?? artist)
}
