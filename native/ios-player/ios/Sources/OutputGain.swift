import Foundation

// Renders a shared Rust gain plan without changing user volume.
struct OutputGain {
    private var enabled = false
    private var revision: Double = -1
    private var gainDb: Double = 0
    private var from: Double = 0
    private var target: Double = 0
    private var began: Double = 0
    mutating func configure(_ value: Bool, _ version: Double) -> Bool {
        guard version.isFinite, version >= revision else { return false }
        enabled = value; revision = version; return true
    }
    mutating func plan(_ db: Double) { gainDb = db.isFinite ? min(0,max(-80,db)) : 0 }
    func current(_ now: Double) -> Double { from + (target-from) * min(1,max(0,(now-began)/300)) }
    mutating func transition(_ now: Double, smooth: Bool) { let next = enabled ? gainDb : 0; from = smooth ? current(now) : next; target = next; began = now }
    func active(_ now: Double) -> Bool { now < began+300 && from != target }
    func level(_ volume: Float, _ now: Double) -> Float { min(1,max(0,volume)) * Float(pow(10,current(now)/20)) }
}
