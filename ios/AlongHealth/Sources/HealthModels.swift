import Foundation

// Half-open windows count complete local days. Calendar day arithmetic also
// handles the 23- and 25-hour days around daylight saving transitions.
struct HealthHistoryWindows {
    let calendar: Calendar
    let start: Date
    let middle: Date
    let end: Date

    init(endingAt boundary: Date, calendar: Calendar) {
        self.calendar = calendar
        end = boundary
        middle = calendar.date(byAdding: .day, value: -7, to: boundary)!
        start = calendar.date(byAdding: .day, value: -7, to: middle)!
    }

    func periods(_ aggregate: (Date, Date) -> [String: Any]) -> [String: Any] {
        let formatter = ISO8601DateFormatter()
        func period(_ lower: Date, _ upper: Date) -> [String: Any] {
            var value = aggregate(lower, upper)
            value["startAt"] = formatter.string(from: lower)
            value["endAt"] = formatter.string(from: upper)
            return value
        }
        return ["recent": period(middle, end), "previous": period(start, middle)]
    }

    func workout(_ records: [(start: Date, seconds: TimeInterval)]) -> [String: Any] {
        periods { lower, upper in
            let matching = records.filter { $0.start >= lower && $0.start < upper }
            let days = Set(matching.map { calendar.startOfDay(for: $0.start) }).count
            let minutes = Int(matching.reduce(0.0) { $0 + $1.seconds } / 60)
            return ["daysWithData": days,
                    "count": matching.isEmpty ? NSNull() as Any : matching.count,
                    "value": matching.isEmpty ? NSNull() as Any : minutes]
        }
    }

    func weight(_ records: [(at: Date, kilograms: Double)]) -> [String: Any] {
        periods { lower, upper in
            var latest: [Date: (at: Date, kilograms: Double)] = [:]
            for record in records where record.at >= lower && record.at < upper && record.kilograms > 0 && record.kilograms.isFinite {
                let day = calendar.startOfDay(for: record.at)
                if let saved = latest[day], saved.at >= record.at { continue }
                latest[day] = record
            }
            let mean = latest.isEmpty ? nil : latest.values.reduce(0.0) { $0 + $1.kilograms } / Double(latest.count)
            return ["daysWithData": latest.count, "value": mean.map { ($0 * 10).rounded() / 10 } as Any? ?? NSNull()]
        }
    }
}

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

    func summarize(_ records: [DateInterval], includeHistory: Bool) -> (latestMinutes: Int?, summary: [String: Any]?, history: [String: Any]?) {
        let windows = HealthHistoryWindows(endingAt: averageThrough, calendar: calendar)
        let lowerBound = includeHistory ? windows.start : start
        var merged: [DateInterval] = []
        for record in records.filter({ $0.start < latestEnd && $0.end > lowerBound }).sorted(by: { $0.start < $1.start }) {
            if let last = merged.last, record.start <= last.end {
                merged[merged.count - 1] = DateInterval(start: last.start, end: max(last.end, record.end))
            } else {
                merged.append(record)
            }
        }
        func asleepMinutes(from lower: Date, through upper: Date) -> Int? {
            let seconds = merged.reduce(0.0) { total, record in
                total + max(0, min(record.end, upper).timeIntervalSince(max(record.start, lower)))
            }
            return seconds > 0 ? Int(seconds / 60) : nil
        }
        func dailyTotals(through end: Date) -> [Int] {
            (0..<7).compactMap { offset in
                let upper = calendar.date(byAdding: .day, value: -offset, to: end)!
                return asleepMinutes(from: calendar.date(byAdding: .day, value: -1, to: upper)!, through: upper)
            }
        }
        let completedDays = dailyTotals(through: averageThrough)
        let history = includeHistory ? windows.periods { _, upper in
            let days = upper == averageThrough ? completedDays : dailyTotals(through: upper)
            let mean = days.isEmpty ? nil : days.reduce(0, +) / days.count
            return ["daysWithData": days.count, "value": mean as Any? ?? NSNull()]
        } : nil
        guard merged.contains(where: { $0.end > start }) else { return (nil, nil, history) }
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
        return (latestMinutes, summary, history)
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
        case .workout: "本周运动、近两周对比与近 28 天时段汇总"
        case .activeEnergy: "今天主动活动消耗的千卡数"
        case .weight: "最近一次体重、近两周按日汇总的平均体重"
        case .restingHeartRate: "近 7 天最近一次估计值"
        case .wristTemperature: "近 30 天最近一次绝对温度"
        case .sleep: "最近睡眠时段、近两周有记录日期的平均时长"
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
    var recentHistory: [String: [String: Any]] = [:]

    private var previousSleepMinutes: Int? {
        (recentHistory["sleep"]?["previous"] as? [String: Any])?["value"] as? Int
    }

    var hasReadableValue: Bool {
        steps != nil || workoutMinutes != nil || weightKg != nil || sleepSummary != nil || sleepMinutes != nil ||
        activeEnergyKcal != nil || restingHeartRate != nil || wristTemperatureC != nil || previousSleepMinutes != nil
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
            return latest ?? previousSleepMinutes.map { "前一个 7 天窗口有记录，平均 \($0) 分钟" } ?? "无可读取记录"
        }
    }

    func historyPreview(for metric: HealthMetric) -> [String] {
        guard let history = recentHistory[metric.rawValue] else { return [] }
        let parser = ISO8601DateFormatter()
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = .current
        formatter.dateFormat = metric == .sleep ? "M月d日 HH:mm" : "M月d日"
        return ["recent", "previous"].compactMap { key in
            guard let period = history[key] as? [String: Any],
                  let start = (period["startAt"] as? String).flatMap(parser.date(from:)),
                  let end = (period["endAt"] as? String).flatMap(parser.date(from:)),
                  let days = period["daysWithData"] as? Int else { return nil }
            // Sleep ends at 18:00; calendar-day summaries display inclusive dates.
            let upper = metric == .sleep ? end : end.addingTimeInterval(-1)
            let dates = formatter.string(from: start) + "至" + formatter.string(from: upper)
            guard let value = period["value"] as? NSNumber else { return "\(dates) · 0/7 天有记录" }
            let amount: String
            switch metric {
            case .sleep: amount = "平均 \(value.intValue) 分钟"
            case .weight: amount = String(format: "日均 %.1f 公斤", value.doubleValue)
            case .workout: amount = "累计 \(value.intValue) 分钟，\(period["count"] as? Int ?? 0) 次"
            default: return nil
            }
            return "\(dates) · \(days)/7 天有记录 · \(amount)"
        }
    }

    func browserSnapshot(contextReviewAllowed: Bool, comparisonHistoryAllowed: Bool = false) -> [String: Any] {
        let selectedNames = Set(selected.map(\.rawValue))
        let history = recentHistory.filter { selectedNames.contains($0.key) && ($0.key == "workout" || comparisonHistoryAllowed) }
        return ["steps": steps as Any? ?? NSNull(),
         "workoutMinutes": workoutMinutes as Any? ?? NSNull(),
         "workoutCount": workoutCount as Any? ?? NSNull(),
         "weightKg": weightKg as Any? ?? NSNull(),
         "sleepMinutes": sleepMinutes as Any? ?? NSNull(),
         "activeEnergyKcal": activeEnergyKcal as Any? ?? NSNull(),
         "restingHeartRate": restingHeartRate as Any? ?? NSNull(),
         "wristTemperatureC": wristTemperatureC as Any? ?? NSNull(),
         "selectedTypes": selected.map(\.rawValue),
         "contextReviewAllowed": contextReviewAllowed,
         "comparisonHistoryAllowed": contextReviewAllowed && comparisonHistoryAllowed,
         "capturedAt": ISO8601DateFormatter().string(from: capturedAt),
         "sleepSummary": (contextReviewAllowed ? sleepSummary : nil) as Any? ?? NSNull(),
         "workoutSummary": (contextReviewAllowed ? workoutSummary : nil) as Any? ?? NSNull(),
         "recentHistory": contextReviewAllowed ? history as Any : NSNull()]
    }
}
