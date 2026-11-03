import Foundation
import HealthKit

final class HealthKitReader {
    private let store = HKHealthStore()

    func read(_ selection: Set<HealthMetric>) async throws -> HealthSummary {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw ReaderError.unavailable
        }
        let ordered = HealthMetric.allCases.filter { selection.contains($0) }
        guard !ordered.isEmpty else { throw ReaderError.emptySelection }
        let types: Set<HKObjectType> = Set(ordered.map { metric -> HKObjectType in
            switch metric {
            case .steps: HKQuantityType.quantityType(forIdentifier: .stepCount)!
            case .workout: HKObjectType.workoutType()
            case .weight: HKQuantityType.quantityType(forIdentifier: .bodyMass)!
            case .sleep: HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!
            }
        })
        // This requests read access only for the boxes the person checked.
        try await store.requestAuthorization(toShare: Set<HKSampleType>(), read: types)

        let now = Date()
        var result = HealthSummary(selected: ordered, capturedAt: now)
        if selection.contains(.steps) { result.steps = try await todaySteps(now: now) }
        if selection.contains(.workout) {
            let workout = try await thisWeekWorkouts(now: now)
            result.workoutMinutes = workout?.minutes
            result.workoutCount = workout?.count
        }
        if selection.contains(.weight) { result.weightKg = try await latestWeight() }
        if selection.contains(.sleep) { result.sleepMinutes = try await lastNightSleep(now: now) }
        return result
    }

    private func todaySteps(now: Date) async throws -> Int? {
        let type = HKQuantityType.quantityType(forIdentifier: .stepCount)!
        let start = Calendar.current.startOfDay(for: now)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: .strictStartDate)
        let statistics = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<HKStatistics?, Error>) in
            let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, value, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value) }
            }
            store.execute(query)
        }
        guard let count = statistics?.sumQuantity()?.doubleValue(for: .count()) else { return nil }
        return max(0, Int(count.rounded(.down)))
    }

    private func thisWeekWorkouts(now: Date) async throws -> (minutes: Int, count: Int)? {
        let start = Calendar.current.dateInterval(of: .weekOfYear, for: now)!.start
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: .strictStartDate)
        let workouts = try await samples(of: .workoutType(), predicate: predicate).compactMap { $0 as? HKWorkout }
        guard !workouts.isEmpty else { return nil }
        let seconds = workouts.reduce(0.0) { $0 + $1.duration }
        return (Int((seconds / 60).rounded(.down)), workouts.count)
    }

    private func latestWeight() async throws -> Double? {
        let type = HKQuantityType.quantityType(forIdentifier: .bodyMass)!
        let sorted = [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]
        let values = try await samples(of: type, predicate: nil, limit: 1, sort: sorted)
        guard let latest = values.first as? HKQuantitySample else { return nil }
        return (latest.quantity.doubleValue(for: .gramUnit(with: .kilo)) * 10).rounded() / 10
    }

    private func lastNightSleep(now: Date) async throws -> Int? {
        let midnight = Calendar.current.startOfDay(for: now)
        let start = Calendar.current.date(byAdding: .hour, value: -6, to: midnight)!
        let noon = Calendar.current.date(byAdding: .hour, value: 12, to: midnight)!
        let end = min(now, noon)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        let values = try await samples(of: HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!, predicate: predicate)
        let ranges = values.compactMap { sample -> DateInterval? in
            guard let sleep = sample as? HKCategorySample,
                  let stage = HKCategoryValueSleepAnalysis(rawValue: sleep.value),
                  HKCategoryValueSleepAnalysis.allAsleepValues.contains(stage) else { return nil }
            let lower = max(start, sleep.startDate), upper = min(end, sleep.endDate)
            return lower < upper ? DateInterval(start: lower, end: upper) : nil
        }.sorted { $0.start < $1.start }
        guard !ranges.isEmpty else { return nil }
        // Merge overlaps, including duplicate recordings from multiple devices.
        var total: TimeInterval = 0
        var current = ranges[0]
        for range in ranges.dropFirst() {
            if range.start <= current.end { current = DateInterval(start: current.start, end: max(current.end, range.end)) }
            else { total += current.duration; current = range }
        }
        total += current.duration
        return Int((total / 60).rounded(.down))
    }

    private func samples(of type: HKSampleType, predicate: NSPredicate?, limit: Int = HKObjectQueryNoLimit, sort: [NSSortDescriptor]? = nil) async throws -> [HKSample] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: limit, sortDescriptors: sort) { _, values, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: values ?? []) }
            }
            store.execute(query)
        }
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
