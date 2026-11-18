import Foundation

// Shared by HealthKit and account collectors. Authorization belongs to the
// producer; a receipt can only advance the exact durable event it names.
enum DeviceEventQueue {
    enum Receipt { case acknowledged, held, retry }

    static func disposition(event: [String: Any], receipt: [String: Any]) -> Receipt {
        guard let id = event["event_id"] as? String, !id.isEmpty,
              receipt["event_id"] as? String == id else { return .retry }
        switch receipt["status"] as? String {
        case "accepted", "duplicate": return .acknowledged
        case "stale", "rejected", "conflict": return .held
        default: return .retry
        }
    }

    static func append(_ event: [String: Any], to state: inout [String: Any], maxPending: Int = 200, maxEventBytes: Int = 64 * 1024, maxPendingBytes: Int? = nil) throws {
        guard let id = event["event_id"] as? String, !id.isEmpty else { throw QueueError.invalidEvent }
        let bytes = try JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
        guard maxEventBytes > 0, maxEventBytes <= 2_300_000, bytes.count <= maxEventBytes else { throw QueueError.invalidEvent }
        var pending = state["pending"] as? [[String: Any]] ?? []
        if let prior = pending.first(where: { $0["event_id"] as? String == id }) {
            guard try JSONSerialization.data(withJSONObject: prior, options: [.sortedKeys]) == bytes else { throw QueueError.conflict }
            return
        }
        guard pending.count < maxPending else { throw QueueError.full }
        if let maxPendingBytes {
            guard maxPendingBytes > 0, maxPendingBytes <= 8 * 1024 * 1024,
                  try JSONSerialization.data(withJSONObject: pending + [event], options: [.sortedKeys]).count <= maxPendingBytes else { throw QueueError.full }
        }
        pending.append(event)
        state["pending"] = pending
    }

    @discardableResult
    static func advance(_ state: inout [String: Any], receipt: [String: Any], maxHeldBytes: Int? = nil) -> Receipt {
        var pending = state["pending"] as? [[String: Any]] ?? []
        guard let first = pending.first else { return .retry }
        let result = disposition(event: first, receipt: receipt)
        if result == .retry { return result }
        if result == .held {
            var held = state["held"] as? [[String: Any]] ?? []
            held.append(["event": first, "receipt": receipt])
            held = Array(held.suffix(100))
            if let maxHeldBytes {
                while !held.isEmpty && ((try? JSONSerialization.data(withJSONObject: held).count) ?? Int.max) > maxHeldBytes { held.removeFirst() }
            }
            state["held"] = held
        }
        pending.removeFirst()
        state["pending"] = pending
        return result
    }

    enum QueueError: Error { case invalidEvent, conflict, full }
}
