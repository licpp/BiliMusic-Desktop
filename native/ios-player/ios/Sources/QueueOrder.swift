import Foundation

// The source order retains the audible row while the visible queue filters it out.
func orderedQueueTarget(_ order: [String], _ visible: [String], _ current: String, _ direction: Int, _ wrap: Bool) -> String? {
    let sequence = visible.contains(current) ? visible : order
    guard let index = sequence.firstIndex(of: current) else { return direction > 0 ? visible.first : visible.last }
    let available = Set(visible)
    let candidates = direction > 0 ? Array(sequence.dropFirst(index + 1)) : Array(sequence.prefix(index).reversed())
    return candidates.first(where: { available.contains($0) }) ?? (wrap ? (direction > 0 ? visible.first : visible.last) : nil)
}
