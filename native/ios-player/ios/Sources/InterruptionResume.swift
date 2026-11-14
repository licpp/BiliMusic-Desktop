struct InterruptionResume {
    private var pending = false
    mutating func begin(wasPlaying: Bool) { pending = pending || wasPlaying }
    mutating func cancel() { pending = false }
    mutating func finish(allowed: Bool) -> Bool {
        let resume = pending && allowed
        pending = false
        return resume
    }
}
