struct InterruptionResume {
    private var pending = false
    private var heardOtherAudio = false
    private var quietSamples = 0
    private var revision: UInt64 = 0
    var mayParkMedia: Bool { !pending }
    var foregroundToken: UInt64? { pending ? revision : nil }
    mutating func begin(wasPlaying: Bool) { revision &+= 1; pending = pending || wasPlaying }
    mutating func cancel() {
        revision &+= 1; pending = false; heardOtherAudio = false; quietSamples = 0
    }
    // A media app can omit the end event. While iOS allows background work,
    // look for an observed competing stream to go quiet before trying once.
    mutating func competingAudioEnded(isPlaying: Bool) -> Bool {
        guard pending else { return false }
        if isPlaying { heardOtherAudio = true; quietSamples = 0; return false }
        guard heardOtherAudio else { return false }
        quietSamples += 1
        return quietSamples == 2
    }
    func canRecoverInForeground(token: UInt64, otherAudioPlaying: Bool) -> Bool {
        pending && revision == token && !otherAudioPlaying
    }
    mutating func finish(allowed: Bool) -> Bool {
        let resume = pending && allowed
        cancel()
        return resume
    }
}
