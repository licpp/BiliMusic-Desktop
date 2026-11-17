struct InterruptionResume {
    private var pending = false
    private var revision: UInt64 = 0
    var foregroundToken: UInt64? { pending ? revision : nil }
    mutating func begin(wasPlaying: Bool) { revision &+= 1; pending = pending || wasPlaying }
    mutating func cancel() { revision &+= 1; pending = false }
    // Legacy iOS may never deliver an interruption end after another media app.
    // Only a return to this app may reconcile that missing event. A later system
    // denial or explicit command invalidates the captured token as well.
    func canRecoverInForeground(token: UInt64, otherAudioPlaying: Bool) -> Bool {
        pending && revision == token && !otherAudioPlaying
    }
    mutating func finish(allowed: Bool) -> Bool {
        let resume = pending && allowed
        cancel()
        return resume
    }
}
