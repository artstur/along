import Foundation

enum HealthMetric: String, CaseIterable, Identifiable {
    case steps, workout, weight, sleep

    var id: String { rawValue }
    var title: String {
        switch self {
        case .steps: "步数"
        case .workout: "健身记录"
        case .weight: "体重"
        case .sleep: "睡眠"
        }
    }
    var period: String {
        switch self {
        case .steps: "今天的总步数"
        case .workout: "本周总分钟数与次数"
        case .weight: "最近一次体重"
        case .sleep: "昨晚睡眠分钟数"
        }
    }
}

struct HealthSummary {
    let selected: [HealthMetric]
    let capturedAt: Date
    var steps: Int?
    var workoutMinutes: Int?
    var workoutCount: Int?
    var weightKg: Double?
    var sleepMinutes: Int?

    var hasReadableValue: Bool {
        steps != nil || workoutMinutes != nil || weightKg != nil || sleepMinutes != nil
    }

    func displayValue(for metric: HealthMetric) -> String {
        switch metric {
        case .steps: return steps.map { "\($0) 步" } ?? "无可读取记录"
        case .workout:
            guard let workoutMinutes, let workoutCount else { return "无可读取记录" }
            return "\(workoutMinutes) 分钟 · \(workoutCount) 次"
        case .weight: return weightKg.map { String(format: "%.1f kg", $0) } ?? "无可读取记录"
        case .sleep: return sleepMinutes.map { "\($0) 分钟" } ?? "无可读取记录"
        }
    }

    func browserSnapshot() -> [String: Any] {
        ["steps": steps as Any? ?? NSNull(),
         "workoutMinutes": workoutMinutes as Any? ?? NSNull(),
         "workoutCount": workoutCount as Any? ?? NSNull(),
         "weightKg": weightKg as Any? ?? NSNull(),
         "sleepMinutes": sleepMinutes as Any? ?? NSNull(),
         "selectedTypes": selected.map(\.rawValue)]
    }

    func syncPayload() -> [String: Any] {
        var snapshot: [String: Any] = [:]
        for metric in selected {
            switch metric {
            case .steps: snapshot["steps"] = steps as Any? ?? NSNull()
            case .workout:
                snapshot["workoutMinutes"] = workoutMinutes as Any? ?? NSNull()
                snapshot["workoutCount"] = workoutCount as Any? ?? NSNull()
            case .weight: snapshot["weightKg"] = weightKg as Any? ?? NSNull()
            case .sleep: snapshot["sleepMinutes"] = sleepMinutes as Any? ?? NSNull()
            }
        }
        return ["schema": 1,
                "source": "healthkit",
                "selectedTypes": selected.map(\.rawValue),
                "capturedAt": ISO8601DateFormatter().string(from: capturedAt),
                "snapshot": snapshot]
    }
}
