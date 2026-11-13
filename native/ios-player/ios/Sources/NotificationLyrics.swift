import Foundation

struct NativeLyricWord: Decodable {
    let text: String; let startTimeMs: Double; let endTimeMs: Double
}
struct NativeLyricLine: Decodable {
    let timeMs: Double; let endTimeMs: Double?; let text: String; let words: [NativeLyricWord]?
}
struct NativeLyricsRequest: Decodable {
    let action: String; let id: String?; let lines: [NativeLyricLine]?; let biasMs: Double?; let subtitles: Bool?
}
struct NativeSavedLyrics: Decodable {
    let rawText: String; let parsedJson: String; let biasMs: Double
    var lines: [NativeLyricLine] {
        guard rawText.range(of:"\\[\\d{1,3}:\\d{1,2}",options:.regularExpression) != nil,let data=parsedJson.data(using:.utf8) else { return [] }
        return (try? JSONDecoder().decode([NativeLyricLine].self,from:data)) ?? []
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
    func update(_ value: NativeLyricsRequest) { request=value }
    func clear() { request=nil }
    func line(for trackID: String?, at position: Double) -> String? {
        guard let trackID,!trackID.isEmpty,let request,request.id==trackID,
              position.isFinite,let lines=request.lines,
              let index=lines.lastIndex(where: { $0.timeMs <= position*1000-(request.biasMs ?? 0) }) else { return nil }
        let current=lines[index]
        // Subtitle cues have real gaps; ordinary lyrics hold until the next line.
        if request.subtitles == true,let end=current.endTimeMs,position*1000-(request.biasMs ?? 0)>=end { return nil }
        let text=current.text.components(separatedBy:.newlines).joined(separator:" ").trimmingCharacters(in:.whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}
