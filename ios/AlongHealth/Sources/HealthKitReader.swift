import Foundation
import HealthKit

final class HealthKitReader {
    private let store = HKHealthStore()
    private var observers: [HKObserverQuery] = []

    func read(_ selection: Set<HealthMetric>, requestPermission: Bool = true, includeContext: Bool = true) async throws -> HealthSummary {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw ReaderError.unavailable
        }
        let ordered = HealthMetric.allCases.filter { selection.contains($0) }
        guard !ordered.isEmpty else { throw ReaderError.emptySelection }
        let types: Set<HKObjectType> = Set(ordered.map { metric -> HKObjectType in
            switch metric {
            case .steps: HKQuantityType.quantityType(forIdentifier: .stepCount)!
            case .workout: HKObjectType.workoutType()
            case .activeEnergy: HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!
            case .weight: HKQuantityType.quantityType(forIdentifier: .bodyMass)!
            case .restingHeartRate: HKQuantityType.quantityType(forIdentifier: .restingHeartRate)!
            case .wristTemperature: HKQuantityType.quantityType(forIdentifier: .appleSleepingWristTemperature)!
            case .sleep: HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!
            }
        })
        // This requests read access only for the boxes the person checked.
        if requestPermission {
            try await store.requestAuthorization(toShare: Set<HKSampleType>(), read: types)
        }

        let now = Date()
        var result = HealthSummary(selected: ordered, capturedAt: now)
        if selection.contains(.steps) { result.steps = try await todaySteps(now: now) }
        if selection.contains(.workout) {
            let workout = try await recentWorkouts(now: now, includeContext: includeContext)
            result.workoutMinutes = workout?.minutes
            result.workoutCount = workout?.count
            result.workoutSummary = workout?.summary
        }
        if selection.contains(.weight) { result.weightKg = try await latestWeight() }
        if selection.contains(.sleep) {
            let sleep = try await recentSleep(now: now, includeContext: includeContext)
            result.sleepMinutes = sleep?.latestMinutes
            result.sleepSummary = sleep?.summary
        }
        if selection.contains(.activeEnergy) { result.activeEnergyKcal = try await todayActiveEnergy(now: now) }
        if selection.contains(.restingHeartRate) { result.restingHeartRate = try await latestRestingHeartRate(now: now) }
        if selection.contains(.wristTemperature) { result.wristTemperatureC = try await latestWristTemperature(now: now) }
        return result
    }

    func observe(_ selection: Set<HealthMetric>, onChange: @escaping () -> Void) {
        stopObserving()
        for metric in selection {
            let type: HKSampleType
            switch metric {
            case .steps: type = HKObjectType.quantityType(forIdentifier: .stepCount)!
            case .workout: type = .workoutType()
            case .activeEnergy: type = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned)!
            case .weight: type = HKObjectType.quantityType(forIdentifier: .bodyMass)!
            case .restingHeartRate: type = HKObjectType.quantityType(forIdentifier: .restingHeartRate)!
            case .wristTemperature: type = HKObjectType.quantityType(forIdentifier: .appleSleepingWristTemperature)!
            case .sleep: type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
            }
            let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completion, error in
                if error == nil { onChange() }
                completion()
            }
            observers.append(query)
            store.execute(query)
        }
    }

    func stopObserving() {
        observers.forEach { store.stop($0) }
        observers.removeAll()
    }

    private func todaySteps(now: Date) async throws -> Int? {
        let type = HKQuantityType.quantityType(forIdentifier: .stepCount)!
        let start = Calendar.current.startOfDay(for: now)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: .strictStartDate)
        let statistics = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<HKStatistics?, Error>) in
            let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, value, error in
                if let error, Self.isNoData(error) { continuation.resume(returning: nil) }
                else if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value) }
            }
            store.execute(query)
        }
        guard let count = statistics?.sumQuantity()?.doubleValue(for: .count()) else { return nil }
        return max(0, Int(count.rounded(.down)))
    }

    private func todayActiveEnergy(now: Date) async throws -> Int? {
        let type = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!
        let start = Calendar.current.startOfDay(for: now)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: .strictStartDate)
        let statistics = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<HKStatistics?, Error>) in
            let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, value, error in
                if let error, Self.isNoData(error) { continuation.resume(returning: nil) }
                else if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value) }
            }
            store.execute(query)
        }
        guard let kcal = statistics?.sumQuantity()?.doubleValue(for: .kilocalorie()) else { return nil }
        return max(0, Int(kcal.rounded()))
    }

    private func latestRestingHeartRate(now: Date) async throws -> Int? {
        let type = HKQuantityType.quantityType(forIdentifier: .restingHeartRate)!
        guard let sample = try await latestQuantity(type, since: -7, now: now) else { return nil }
        let beatsPerMinute = HKUnit.count().unitDivided(by: .minute())
        return max(0, Int(sample.quantity.doubleValue(for: beatsPerMinute).rounded()))
    }

    private func latestWristTemperature(now: Date) async throws -> Double? {
        let type = HKQuantityType.quantityType(forIdentifier: .appleSleepingWristTemperature)!
        guard let sample = try await latestQuantity(type, since: -30, now: now) else { return nil }
        return (sample.quantity.doubleValue(for: .degreeCelsius()) * 10).rounded() / 10
    }

    private func latestQuantity(_ type: HKQuantityType, since days: Int, now: Date) async throws -> HKQuantitySample? {
        guard let start = Calendar.current.date(byAdding: .day, value: days, to: now) else { return nil }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: [])
        let sorted = [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]
        return try await samples(of: type, predicate: predicate, limit: 1, sort: sorted).first as? HKQuantitySample
    }

    private func recentWorkouts(now: Date, includeContext: Bool) async throws -> (minutes: Int, count: Int, summary: [String: Any])? {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = .current
        let weekStart = calendar.dateInterval(of: .weekOfYear, for: now)!.start
        let todayStart = calendar.startOfDay(for: now)
        let yesterdayStart = calendar.date(byAdding: .day, value: -1, to: todayStart)!
        let recentStart = calendar.date(byAdding: .day, value: -6, to: todayStart)!
        let start = includeContext ? calendar.date(byAdding: .day, value: -27, to: todayStart)! : weekStart
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: .strictStartDate)
        let workouts = try await samples(of: .workoutType(), predicate: predicate).compactMap { $0 as? HKWorkout }
        guard !workouts.isEmpty else { return nil }
        let week = workouts.filter { $0.startDate >= weekStart }
        let weekMinutes = Int(week.reduce(0.0) { $0 + $1.duration } / 60)
        guard includeContext else { return (weekMinutes, week.count, [:]) }
        let today = workouts.filter { $0.startDate >= todayStart }
        let yesterday = workouts.filter { $0.startDate >= yesterdayStart && $0.startDate < todayStart }
        // Only grouped counts/timing/durations cross the bridge, never HKWorkout samples.
        let groups = Dictionary(grouping: workouts) { workout in
            "\(workout.workoutActivityType.rawValue)-\((calendar.component(.weekday, from: workout.startDate) + 5) % 7 + 1)-\(calendar.component(.hour, from: workout.startDate))"
        }
        let formatter = ISO8601DateFormatter()
        let newestGroups = groups.sorted { lhs, rhs in
            let left = lhs.value.map(\.startDate).max()!
            let right = rhs.value.map(\.startDate).max()!
            return left == right ? lhs.key < rhs.key : left > right
        }
        let patterns: [[String: Any]] = newestGroups.prefix(40).compactMap { _, values in
            guard let first = values.first, let latest = values.map(\.startDate).max() else { return nil }
            return ["activity": Self.activityName(first.workoutActivityType),
                    "weekday": (calendar.component(.weekday, from: first.startDate) + 5) % 7 + 1,
                    "hour": calendar.component(.hour, from: first.startDate), "count": values.count,
                    "recentCount": values.filter { $0.startDate >= recentStart }.count,
                    "averageMinutes": Int(values.reduce(0.0) { $0 + $1.duration } / Double(values.count) / 60),
                    "lastObservedAt": formatter.string(from: calendar.startOfDay(for: latest))]
        }
        let summary: [String: Any] = ["windowDays": 28, "weekStartAt": formatter.string(from: weekStart),
            "todayMinutes": Int(today.reduce(0.0) { $0 + $1.duration } / 60), "todayCount": today.count,
            "yesterdayMinutes": Int(yesterday.reduce(0.0) { $0 + $1.duration } / 60),
            "latestWorkoutAt": formatter.string(from: workouts.map(\.startDate).max()!), "patterns": patterns]
        return (weekMinutes, week.count, summary)
    }

    private static func activityName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .yoga: "yoga"
        case .walking: "walking"
        case .hiking: "hiking"
        case .running: "running"
        case .cycling: "cycling"
        case .swimming: "swimming"
        case .pilates: "pilates"
        case .traditionalStrengthTraining: "strength_training"
        case .functionalStrengthTraining: "functional_strength_training"
        case .highIntensityIntervalTraining: "hiit"
        default: "healthkit_activity_\(type.rawValue)"
        }
    }

    private func latestWeight() async throws -> Double? {
        let type = HKQuantityType.quantityType(forIdentifier: .bodyMass)!
        let sorted = [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]
        let values = try await samples(of: type, predicate: nil, limit: 1, sort: sorted)
        guard let latest = values.first as? HKQuantitySample else { return nil }
        return (latest.quantity.doubleValue(for: .gramUnit(with: .kilo)) * 10).rounded() / 10
    }

    private func recentSleep(now: Date, includeContext: Bool) async throws -> (latestMinutes: Int?, summary: [String: Any])? {
        let window = SleepObservationWindow(now: now, calendar: .current)
        let start = includeContext ? window.start : Calendar.current.date(byAdding: .day, value: -1, to: window.latestBoundary)!
        let predicate = HKQuery.predicateForSamples(withStart: start, end: window.latestEnd, options: [])
        let values = try await samples(of: HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!, predicate: predicate)
        let ranges = values.compactMap { sample -> DateInterval? in
            guard let sleep = sample as? HKCategorySample,
                  let stage = HKCategoryValueSleepAnalysis(rawValue: sleep.value),
                  HKCategoryValueSleepAnalysis.allAsleepValues.contains(stage) else { return nil }
            return sleep.startDate < sleep.endDate ? DateInterval(start: sleep.startDate, end: sleep.endDate) : nil
        }
        return window.summarize(ranges)
    }

    private func samples(of type: HKSampleType, predicate: NSPredicate?, limit: Int = HKObjectQueryNoLimit, sort: [NSSortDescriptor]? = nil) async throws -> [HKSample] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: limit, sortDescriptors: sort) { _, values, error in
                if let error, Self.isNoData(error) { continuation.resume(returning: []) }
                else if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: values ?? []) }
            }
            store.execute(query)
        }
    }

    private static func isNoData(_ error: Error) -> Bool {
        let value = error as NSError
        return value.domain == HKErrorDomain && value.code == HKError.Code.errorNoData.rawValue
    }
}

enum ReaderError: LocalizedError {
    case unavailable, emptySelection
    var errorDescription: String? {
        switch self {
        case .unavailable: "这台设备无法读取 Apple Health。请使用 iPhone 真机。"
        case .emptySelection: "请至少选择一种数据。"
        }
    }
}
