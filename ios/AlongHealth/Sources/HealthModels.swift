import Foundation

// Group overlapping asleep stages locally. A sleep day ends at 18:00 local time,
// so a late bedtime and a late-morning wake normally stay in the same window.
struct SleepObservationWindow {
    let calendar: Calendar
    let latestEnd: Date
    let latestBoundary: Date
    let averageThrough: Date
    let start: Date

    init(now: Date, calendar: Calendar) {
        self.calendar = calendar
        latestBoundary = calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now)!
        latestEnd = min(now, latestBoundary)
        averageThrough = now < latestBoundary ? calendar.date(byAdding: .day, value: -1, to: latestBoundary)! : latestBoundary
        start = calendar.date(byAdding: .day, value: -7, to: averageThrough)!
    }

    func summarize(_ records: [DateInterval]) -> (latestMinutes: Int?, summary: [String: Any])? {
        var merged: [DateInterval] = []
        for record in records.filter({ $0.start < latestEnd && $0.end > start }).sorted(by: { $0.start < $1.start }) {
            if let last = merged.last, record.start <= last.end {
                merged[merged.count - 1] = DateInterval(start: last.start, end: max(last.end, record.end))
            } else {
                merged.append(record)
            }
        }
        guard !merged.isEmpty else { return nil }
        func asleepMinutes(from lower: Date, through upper: Date) -> Int? {
            let seconds = merged.reduce(0.0) { total, record in
                total + max(0, min(record.end, upper).timeIntervalSince(max(record.start, lower)))
            }
            return seconds > 0 ? Int(seconds / 60) : nil
        }
        let completedDays = (0..<7).compactMap { offset -> Int? in
            let upper = calendar.date(byAdding: .day, value: -offset, to: averageThrough)!
            return asleepMinutes(from: calendar.date(byAdding: .day, value: -1, to: upper)!, through: upper)
        }
        let previousBoundary = calendar.date(byAdding: .day, value: -1, to: latestBoundary)!
        let beforePrevious = calendar.date(byAdding: .day, value: -1, to: previousBoundary)!
        let latest = merged.filter { $0.start < latestEnd && $0.end > previousBoundary }
        let latestMinutes = asleepMinutes(from: previousBoundary, through: latestEnd)
        let timestamp = ISO8601DateFormatter()
        let firstStart = latest.first.flatMap { $0.start >= previousBoundary ? timestamp.string(from: $0.start) : nil }
        let lastEnd = latest.last.flatMap { $0.end <= latestEnd ? timestamp.string(from: $0.end) : nil }
        let average = completedDays.isEmpty ? nil : completedDays.reduce(0, +) / completedDays.count
        let summary: [String: Any] = ["windowDays": 7, "daysWithData": completedDays.count,
            "averageThroughAt": timestamp.string(from: averageThrough), "latestWindowOpen": latestEnd < latestBoundary,
            "averageMinutes": average as Any? ?? NSNull(), "latestNightMinutes": latestMinutes as Any? ?? NSNull(),
            "previousNightMinutes": asleepMinutes(from: beforePrevious, through: previousBoundary) as Any? ?? NSNull(),
            "latestSleepStartAt": firstStart as Any? ?? NSNull(), "latestWakeAt": lastEnd as Any? ?? NSNull()]
        return (latestMinutes, summary)
    }
}

enum HealthMetric: String, CaseIterable, Identifiable {
    case steps, workout, activeEnergy, weight, restingHeartRate, wristTemperature, sleep

    var id: String { rawValue }
    var title: String {
        switch self {
        case .steps: "步数"
        case .workout: "健身记录"
        case .activeEnergy: "活动消耗"
        case .weight: "体重"
        case .restingHeartRate: "静息心率"
        case .wristTemperature: "睡眠期间手腕温度"
        case .sleep: "睡眠"
        }
    }
    var period: String {
        switch self {
        case .steps: "今天的总步数"
        case .workout: "本周进度、今日运动量与近 28 天时段汇总"
        case .activeEnergy: "今天主动活动消耗的千卡数"
        case .weight: "最近一次体重"
        case .restingHeartRate: "近 7 天最近一次估计值"
        case .wristTemperature: "近 30 天最近一次绝对温度"
        case .sleep: "最近睡眠时段及 7 天有效记录的平均时长"
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
    var activeEnergyKcal: Int?
    var restingHeartRate: Int?
    var wristTemperatureC: Double?
    var sleepSummary: [String: Any]?
    var workoutSummary: [String: Any]?

    var hasReadableValue: Bool {
        steps != nil || workoutMinutes != nil || weightKg != nil || sleepSummary != nil || sleepMinutes != nil ||
        activeEnergyKcal != nil || restingHeartRate != nil || wristTemperatureC != nil
    }

    func displayValue(for metric: HealthMetric) -> String {
        switch metric {
        case .steps: return steps.map { "\($0) 步" } ?? "无可读取记录"
        case .workout:
            guard let workoutMinutes, let workoutCount else { return "无可读取记录" }
            return "\(workoutMinutes) 分钟 · \(workoutCount) 次"
        case .activeEnergy: return activeEnergyKcal.map { "\($0) 千卡" } ?? "无可读取记录"
        case .weight: return weightKg.map { String(format: "%.1f kg", $0) } ?? "无可读取记录"
        case .restingHeartRate: return restingHeartRate.map { "\($0) 次/分" } ?? "无可读取记录"
        case .wristTemperature: return wristTemperatureC.map { String(format: "%.1f °C（绝对值）", $0) } ?? "无可读取记录"
        case .sleep:
            let latest = sleepMinutes.map { "最近一夜 \($0) 分钟" }
            if let days = sleepSummary?["daysWithData"] as? Int, days > 0,
               let average = sleepSummary?["averageMinutes"] as? Int {
                return [latest, "\(days)/7 天有记录，平均 \(average) 分钟"].compactMap { $0 }.joined(separator: " · ")
            }
            return latest ?? "无可读取记录"
        }
    }

    func browserSnapshot(contextReviewAllowed: Bool) -> [String: Any] {
        ["steps": steps as Any? ?? NSNull(),
         "workoutMinutes": workoutMinutes as Any? ?? NSNull(),
         "workoutCount": workoutCount as Any? ?? NSNull(),
         "weightKg": weightKg as Any? ?? NSNull(),
         "sleepMinutes": sleepMinutes as Any? ?? NSNull(),
         "activeEnergyKcal": activeEnergyKcal as Any? ?? NSNull(),
         "restingHeartRate": restingHeartRate as Any? ?? NSNull(),
         "wristTemperatureC": wristTemperatureC as Any? ?? NSNull(),
         "selectedTypes": selected.map(\.rawValue),
         "contextReviewAllowed": contextReviewAllowed,
         "capturedAt": ISO8601DateFormatter().string(from: capturedAt),
         "sleepSummary": (contextReviewAllowed ? sleepSummary : nil) as Any? ?? NSNull(),
         "workoutSummary": (contextReviewAllowed ? workoutSummary : nil) as Any? ?? NSNull()]
    }
}
