import UserNotifications
import Foundation
import BackgroundTasks
import HealthKit
import JavaScriptCore
import CryptoKit
import Security
import UIKit

final class HealthKitReader {
    private let store = HKHealthStore()
    private var observers: [HKObserverQuery] = []
    private var readingDates: [HealthMetric: Date] = [:]

    func read(_ selection: Set<HealthMetric>, requestPermission: Bool = true, includeContext: Bool = true, includeComparisonHistory: Bool = false) async throws -> HealthSummary {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw ReaderError.unavailable
        }
        let ordered = HealthMetric.allCases.filter { selection.contains($0) }
        guard !ordered.isEmpty else { throw ReaderError.emptySelection }
        var types = Set<HKObjectType>(ordered.map(Self.sampleType))
        // This requests read access only for the boxes the person checked.
        if requestPermission {
            if selection.contains(.workout) && includeContext { types.formUnion(Self.workoutDetailReadTypes()) }
            try await store.requestAuthorization(toShare: Set<HKSampleType>(), read: types)
        }

        let now = Date()
        readingDates = [:]
        var result = HealthSummary(selected: ordered, capturedAt: now)
        if selection.contains(.steps) { result.steps = try await todaySteps(now: now) }
        if selection.contains(.workout) {
            let workout = try await recentWorkouts(now: now, includeContext: includeContext)
            result.workoutMinutes = workout.minutes
            result.workoutCount = workout.count
            result.workoutSummary = workout.summary
            result.recentHistory["workout"] = workout.history
        }
        if selection.contains(.weight) {
            result.weightKg = try await latestWeight()
            if includeContext && includeComparisonHistory { result.recentHistory["weight"] = try await weightHistory(now: now) }
        }
        if selection.contains(.sleep) {
            let sleep = try await recentSleep(now: now, includeContext: includeContext, includeHistory: includeContext && includeComparisonHistory)
            result.sleepMinutes = sleep.latestMinutes
            result.sleepSummary = sleep.summary
            result.recentHistory["sleep"] = sleep.history
        }
        if selection.contains(.activeEnergy) { result.activeEnergyKcal = try await todayActiveEnergy(now: now) }
        if selection.contains(.restingHeartRate) { result.restingHeartRate = try await latestRestingHeartRate(now: now) }
        if selection.contains(.wristTemperature) { result.wristTemperatureC = try await latestWristTemperature(now: now) }
        result.readingDates = readingDates
        return result
    }

    func observe(_ selection: Set<HealthMetric>, onChange: @escaping () -> Void) {
        observeChanges(selection) { completion in onChange(); completion() }
    }

    static func sampleType(_ metric: HealthMetric) -> HKSampleType {
        switch metric {
        case .steps: return HKObjectType.quantityType(forIdentifier: .stepCount)!
        case .workout: return .workoutType()
        case .activeEnergy: return HKObjectType.quantityType(forIdentifier: .activeEnergyBurned)!
        case .weight: return HKObjectType.quantityType(forIdentifier: .bodyMass)!
        case .restingHeartRate: return HKObjectType.quantityType(forIdentifier: .restingHeartRate)!
        case .wristTemperature: return HKObjectType.quantityType(forIdentifier: .appleSleepingWristTemperature)!
        case .sleep: return HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
        }
    }

    // Extra read types belong to the explicitly selected workout summary, never
    // a foreground/background refresh. Optional denial must not break old facts.
    private static func workoutDetailReadTypes() -> Set<HKObjectType> {
        var identifiers: [HKQuantityTypeIdentifier] = [.heartRate, .activeEnergyBurned,
            .distanceWalkingRunning, .distanceCycling, .distanceSwimming, .distanceWheelchair]
        if #available(iOS 18.0, *) { identifiers += [.workoutEffortScore, .estimatedWorkoutEffortScore] }
        return Set(identifiers.compactMap { HKObjectType.quantityType(forIdentifier: $0) })
    }

    func observeChanges(_ selection: Set<HealthMetric>, onChange: @escaping (@escaping () -> Void) -> Void) {
        stopObserving()
        for metric in selection {
            let query = HKObserverQuery(sampleType: Self.sampleType(metric), predicate: nil) { _, completion, error in
                guard error == nil else { completion(); return }
                onChange(completion)
            }
            observers.append(query)
            store.execute(query)
        }
    }

    private var registration: Task<Void, Never>?
    func updateBackgroundDelivery(_ desired: Set<HealthMetric>) {
        let previous = registration
        registration = Task {
            await previous?.value
            let defaults = UserDefaults.standard, key = "along.health.registeredBackgroundTypes.v1"
            var enabled = Set((defaults.stringArray(forKey: key) ?? []).compactMap(HealthMetric.init(rawValue:)))
            for metric in HealthMetric.allCases where desired.contains(metric) || enabled.contains(metric) {
                do {
                    if desired.contains(metric) {
                        try await store.enableBackgroundDelivery(for: Self.sampleType(metric), frequency: .immediate)
                        enabled.insert(metric)
                    } else {
                        try await store.disableBackgroundDelivery(for: Self.sampleType(metric))
                        enabled.remove(metric)
                    }
                    defaults.set(enabled.map(\.rawValue), forKey: key)
                } catch { /* A later launch or permission change retries registration. */ }
            }
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
        readingDates[.restingHeartRate] = sample.endDate
        let beatsPerMinute = HKUnit.count().unitDivided(by: .minute())
        return max(0, Int(sample.quantity.doubleValue(for: beatsPerMinute).rounded()))
    }

    private func latestWristTemperature(now: Date) async throws -> Double? {
        let type = HKQuantityType.quantityType(forIdentifier: .appleSleepingWristTemperature)!
        guard let sample = try await latestQuantity(type, since: -30, now: now) else { return nil }
        readingDates[.wristTemperature] = sample.endDate
        return (sample.quantity.doubleValue(for: .degreeCelsius()) * 10).rounded() / 10
    }

    private func latestQuantity(_ type: HKQuantityType, since days: Int, now: Date) async throws -> HKQuantitySample? {
        guard let start = Calendar.current.date(byAdding: .day, value: days, to: now) else { return nil }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: [])
        let sorted = [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]
        return try await samples(of: type, predicate: predicate, limit: 1, sort: sorted).first as? HKQuantitySample
    }

    private func recentWorkouts(now: Date, includeContext: Bool) async throws -> (minutes: Int?, count: Int?, summary: [String: Any]?, history: [String: Any]?) {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = .current
        let weekStart = calendar.dateInterval(of: .weekOfYear, for: now)!.start
        let todayStart = calendar.startOfDay(for: now)
        let yesterdayStart = calendar.date(byAdding: .day, value: -1, to: todayStart)!
        let recentStart = calendar.date(byAdding: .day, value: -6, to: todayStart)!
        let start = includeContext ? calendar.date(byAdding: .day, value: -27, to: todayStart)! : weekStart
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: .strictStartDate)
        var seen: Set<UUID> = []
        let workouts = try await samples(of: .workoutType(), predicate: predicate).compactMap { $0 as? HKWorkout }
            .filter { $0.endDate <= now && $0.startDate <= $0.endDate && $0.duration.isFinite && $0.duration >= 0
                && $0.duration <= $0.endDate.timeIntervalSince($0.startDate) + 1 && seen.insert($0.uuid).inserted }
            .sorted { $0.startDate == $1.startDate ? $0.uuid.uuidString < $1.uuid.uuidString : $0.startDate > $1.startDate }
        let history = includeContext ? HealthHistoryWindows(endingAt: todayStart, calendar: calendar)
            .workout(workouts.map { ($0.startDate, $0.duration) }) : nil
        guard !workouts.isEmpty else { return (nil, nil, nil, history) }
        let week = workouts.filter { $0.startDate >= weekStart }
        let weekMinutes = Int(week.reduce(0.0) { $0 + $1.duration } / 60)
        guard includeContext else { return (weekMinutes, week.count, nil, nil) }
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
        var recentSessions: [[String: Any]] = []
        for workout in workouts.prefix(7) {
            if let detail = await workoutDetail(workout, now: now) { recentSessions.append(detail) }
        }
        let summary: [String: Any] = ["windowDays": 28, "weekStartAt": formatter.string(from: weekStart),
            "todayMinutes": Int(today.reduce(0.0) { $0 + $1.duration } / 60), "todayCount": today.count,
            "yesterdayMinutes": Int(yesterday.reduce(0.0) { $0 + $1.duration } / 60),
            "latestWorkoutAt": formatter.string(from: workouts.map(\.startDate).max()!), "patterns": patterns,
            "recentSessions": recentSessions]
        return (weekMinutes, week.count, summary, history)
    }

    private func workoutDetail(_ workout: HKWorkout, now: Date) async -> [String: Any]? {
        let indoor = workout.metadata?[HKMetadataKeyIndoorWorkout] as? Bool
        var detail = WorkoutObservation(activity: Self.activityName(workout.workoutActivityType),
            start: workout.startDate, end: workout.endDate, durationSeconds: workout.duration,
            location: indoor.map { $0 ? "indoor" : "outdoor" } ?? "unknown")
        // HKWorkout owns these associated aggregate quantities; no fine-grained
        // sample, identifier, route, device or arbitrary metadata leaves this method.
        detail.distanceMeters = workout.totalDistance?.doubleValue(for: .meter())
        let energy = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!
        detail.activeEnergyKcal = workout.statistics(for: energy)?.sumQuantity()?.doubleValue(for: .kilocalorie())
            ?? workout.totalEnergyBurned?.doubleValue(for: .kilocalorie())
        let heartRate = HKQuantityType.quantityType(forIdentifier: .heartRate)!
        let bpm = HKUnit.count().unitDivided(by: .minute())
        if let stats = try? await associatedStatistics(heartRate, workout: workout) {
            detail.averageHeartRateBpm = stats.averageQuantity()?.doubleValue(for: bpm)
            detail.maximumHeartRateBpm = stats.maximumQuantity()?.doubleValue(for: bpm)
        }
        if #available(iOS 18.0, *) {
            detail.effortScore = try? await workoutEffort(.workoutEffortScore, workout: workout)
            detail.estimatedEffortScore = try? await workoutEffort(.estimatedWorkoutEffortScore, workout: workout)
        }
        return detail.payload(observedAt: now)
    }

    private func associatedStatistics(_ type: HKQuantityType, workout: HKWorkout) async throws -> HKStatistics? {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: HKQuery.predicateForObjects(from: workout),
                options: [.discreteAverage, .discreteMax]) { _, value, error in
                if let error, !Self.isNoData(error) { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value) }
            }
            store.execute(query)
        }
    }

    @available(iOS 18.0, *)
    private func workoutEffort(_ identifier: HKQuantityTypeIdentifier, workout: HKWorkout) async throws -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return nil }
        let predicate = HKQuery.predicateForWorkoutEffortSamplesRelated(workout: workout, activity: nil)
        let sorted = [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]
        guard let value = try await samples(of: type, predicate: predicate, limit: 1, sort: sorted).first as? HKQuantitySample else { return nil }
        return value.quantity.doubleValue(for: .appleEffortScore())
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
        readingDates[.weight] = latest.endDate
        return (latest.quantity.doubleValue(for: .gramUnit(with: .kilo)) * 10).rounded() / 10
    }

    private func weightHistory(now: Date) async throws -> [String: Any] {
        let calendar = Calendar.current
        let windows = HealthHistoryWindows(endingAt: calendar.startOfDay(for: now), calendar: calendar)
        let type = HKQuantityType.quantityType(forIdentifier: .bodyMass)!
        let predicate = HKQuery.predicateForSamples(withStart: windows.start, end: windows.end, options: [])
        let values = try await samples(of: type, predicate: predicate)
        return windows.weight(values.compactMap { sample in
            guard let weight = sample as? HKQuantitySample else { return nil }
            return (weight.endDate, weight.quantity.doubleValue(for: .gramUnit(with: .kilo)))
        })
    }

    private func recentSleep(now: Date, includeContext: Bool, includeHistory: Bool) async throws -> (latestMinutes: Int?, summary: [String: Any]?, history: [String: Any]?) {
        let window = SleepObservationWindow(now: now, calendar: .current)
        let start: Date
        if includeHistory {
            start = HealthHistoryWindows(endingAt: window.averageThrough, calendar: window.calendar).start
        } else if includeContext {
            start = window.start
        } else {
            start = window.calendar.date(byAdding: .day, value: -1, to: window.latestBoundary)!
        }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: window.latestEnd, options: [])
        let values = try await samples(of: HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!, predicate: predicate)
        let stages = values.compactMap { sample -> SleepStageObservation? in
            guard let sleep = sample as? HKCategorySample, sleep.startDate < sleep.endDate,
                  let stage = HKCategoryValueSleepAnalysis(rawValue: sleep.value) else { return nil }
            let name: String
            switch stage {
            case .asleepCore: name = "core"
            case .asleepDeep: name = "deep"
            case .asleepREM: name = "rem"
            case .asleepUnspecified: name = "unspecified"
            case .awake: name = "awake"
            default: return nil
            }
            return SleepStageObservation(interval: DateInterval(start: sleep.startDate, end: sleep.endDate), stage: name)
        }
        let ranges = values.compactMap { sample -> DateInterval? in
            guard let sleep = sample as? HKCategorySample,
                  let stage = HKCategoryValueSleepAnalysis(rawValue: sleep.value),
                  HKCategoryValueSleepAnalysis.allAsleepValues.contains(stage) else { return nil }
            return sleep.startDate < sleep.endDate ? DateInterval(start: sleep.startDate, end: sleep.endDate) : nil
        }
        return window.summarize(ranges, includeHistory: includeHistory, stages: stages)
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

// Web owns goal text and task aliases. Only its scoped template can be used in the background.
enum BackgroundReviewAdmission {
    static func valid(_ template: [String: Any], goalKey: String) -> Bool {
        let keys: Set<String> = ["goalKey", "version", "runtime", "goal", "planning", "selectedTypes", "comparisonHistoryAllowed", "paused", "evaluatedLocalDate", "nextReviewAt"]
        guard Set(template.keys).isSubset(of: keys), template["goalKey"] as? String == goalKey,
              goalKey == "health" || (goalKey.hasPrefix("custom:") && (8...100).contains(goalKey.count)),
              template["runtime"] as? String == "dsh-superagent",
              let version = template["version"] as? String, version.range(of: #"^[A-Za-z0-9._:-]{1,160}$"#, options: .regularExpression) != nil,
              let goal = template["goal"] as? [String: Any], Set(goal.keys).isSubset(of: ["domain", "title", "target"]),
              goal["domain"] as? String == (goalKey == "health" ? "health" : "custom"),
              let title = goal["title"] as? String, !title.isEmpty, title.count <= 120,
              let types = template["selectedTypes"] as? [String], !types.isEmpty,
              let planning = template["planning"] as? [String: Any], planning["kind"] as? String == "context-review", planning["version"] as? Int == 1
        else { return false }
        return true
    }

    static func priorBlocked(_ run: [String: Any], id: String, day: String, grant: [String: Any]) -> [String: Any]? {
        guard run["actual"] as? Bool == true, run["runtime"] as? String == "dsh-superagent", run["kind"] as? String == "goal",
              run["status"] as? String == "blocked", run["requestId"] as? String == id,
              let ticket = run["ticket"] as? [String: Any], let ticketID = ticket["id"] as? String, !ticketID.isEmpty,
              let input = run["input"] as? [String: Any], let snapshot = input["snapshot"] as? [String: Any],
              snapshot["contextReviewAllowed"] as? Bool == true, let planning = snapshot["planning"] as? [String: Any],
              planning["revisionId"] as? String == id, planning["localDate"] as? String == day,
              let original = planning["dailyDelegation"] as? [String: Any], NSDictionary(dictionary: grant).isEqual(to: original)
        else { return nil }
        return ["requestId": id, "ticketId": ticketID, "localDate": day]
    }

    static func covered(_ state: [String: Any], date: String, now: Date, nextReviewAt: String?) -> Bool {
        guard state["lastLocalDate"] as? String == date else { return false }
        guard let nextReviewAt else { return true }
        let iso = ISO8601DateFormatter(), fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let due = fractional.date(from: nextReviewAt) ?? iso.date(from: nextReviewAt) else { return false }
        if due > now { return true }
        guard let stamp = state["lastNow"] as? String, let last = fractional.date(from: stamp) ?? iso.date(from: stamp) else { return false }
        return last >= due
    }

    static func matches(_ state: [String: Any], template: [String: Any], pair: String) -> Bool {
        guard let stored = state["template"] as? [String: Any] else { return false }
        return state["pair"] as? String == pair && stored["goalKey"] as? String == template["goalKey"] as? String &&
            stored["version"] as? String == template["version"] as? String
    }
}

// Protected, app-local review state. An unreadable file (e.g. a locked phone) is never treated as an empty plan.
@MainActor final class BackgroundHealthReviews {
    static let shared = BackgroundHealthReviews()
    static let goalPreference = "along.health.backgroundReviewGoal.v1"
    private let defaults = UserDefaults.standard, reader = HealthKitReader()
    private let armedKey = "along.health.backgroundReviewArmed.v1", dirtyKey = "along.health.backgroundReviewDirty.v1"
    private let observedTypesKey = "along.health.backgroundTargetTypes.v1"
    private let dailyWakeGoal = "along.health.dailyWakeGoal.v1"
    var usesEventProtocol: () -> Bool = { false }
    var scheduleCalendarRefresh: (Date?) -> Void = { _ in }
    var permitsDailyReview: ([String: Any], String, [String]) -> Bool = { _, _, _ in false }
    var deliverDailyResult: ([String: Any], String, [String]) async -> Bool = { _, _, _ in false }
    private var observations: Set<HealthMetric>?
    private var completions: [() -> Void] = []
    private var worker: Task<Void, Never>?
    private var drainGeneration = 0
    private lazy var script: JSContext? = {
        guard let url = Bundle.main.url(forResource: "contextual-planning", withExtension: "mjs", subdirectory: "Web"),
              let source = try? String(contentsOf: url, encoding: .utf8), let context = JSContext() else { return nil }
        // Only evaluate this signed resource. User content is passed as arguments to its functions.
        context.evaluateScript(source.replacingOccurrences(of: #"(?m)^export "#, with: "", options: .regularExpression), withSourceURL: url)
        return context.exception == nil ? context : nil
    }()
    private var authorizedGoal: String? {
        guard defaults.bool(forKey: "along.health.contextReview.v1") else { return nil }
        return defaults.string(forKey: Self.goalPreference)
    }
    private var nativeSelection: Set<HealthMetric> {
        Set((defaults.stringArray(forKey: "along.health.selectedTypes") ?? []).compactMap(HealthMetric.init(rawValue:)))
    }
    private func pairedMac() throws -> ([String: String], String) {
        guard let connection = AlongConnectionStore.load(),
              let seed = AlongConnectionStore.scopeSeed(connection) else { throw AgentBridgeError.invalidConfiguration }
        let epoch = defaults.string(forKey: "along.health.backgroundEpoch.v1") ?? ""
        let digest = SHA256.hash(data: Data([seed, epoch].joined(separator: "\n").utf8)).map { String(format: "%02x", $0) }.joined()
        return (connection, digest)
    }
    private func stateURL() throws -> URL {
        let dir = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var url = dir.appendingPathComponent("AlongBackgroundReviews", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var values = URLResourceValues(); values.isExcludedFromBackup = true; try url.setResourceValues(values)
        return url.appendingPathComponent("review.json")
    }
    private func read() throws -> [String: Any] {
        do {
            let data = try Data(contentsOf: stateURL())
            guard let state = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AgentBridgeError.invalidConfiguration }
            return state
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile { return [:] }
    }
    private func write(_ state: [String: Any]) throws {
        try JSONSerialization.data(withJSONObject: state).write(to: stateURL(), options: [.atomic, .completeFileProtection])
    }
    private func removeState() { if let url = try? stateURL() { try? FileManager.default.removeItem(at: url) } }
    private func sharedFunction(_ name: String, _ args: [Any]) throws -> JSValue {
        guard let script, let f = script.objectForKeyedSubscript(name), !f.isUndefined else { throw AgentBridgeError.invalidConfiguration }
        script.exception = nil
        guard let value = f.call(withArguments: args), script.exception == nil, !value.isUndefined else { throw AgentBridgeError.invalidConfiguration }
        return value
    }

    private func dailyScope(_ template: [String: Any], key: String) -> Bool {
        guard template["goalKey"] as? String == key, template["paused"] as? Bool != true,
              let planning = template["planning"] as? [String: Any], let grant = planning["dailyDelegation"] as? [String: Any],
              let types = template["selectedTypes"] as? [String], !types.isEmpty,
              Set(types).isSubset(of: Set(nativeSelection.map(\.rawValue))) else { return false }
        return permitsDailyReview(grant, key, types)
    }

    private func nextCalendarRefresh() {
        guard let key = authorizedGoal, defaults.bool(forKey: armedKey), defaults.string(forKey: dailyWakeGoal) == key else {
            scheduleCalendarRefresh(nil); return
        }
        let now = Date(), retry = Date(timeIntervalSinceNow: 15 * 60)
        // Protected data and the paired keychain can be unavailable on an overnight wake.
        guard UIApplication.shared.isProtectedDataAvailable, let state = try? read(), let pair = try? pairedMac().1 else {
            scheduleCalendarRefresh(retry); return
        }
        guard let template = state["template"] as? [String: Any],
              BackgroundReviewAdmission.matches(state, template: template, pair: pair), dailyScope(template, key: key) else {
            scheduleCalendarRefresh(nil); return
        }
        let pending = state["pending"] as? [String: Any], completed = state["completed"] as? [String: Any]
        let pendingPlan = ((pending?["request"] as? [String: Any])?["snapshot"] as? [String: Any])?["planning"] as? [String: Any]
        let evaluated = pendingPlan?["localDate"] as? String ?? state["lastLocalDate"] as? String ?? template["evaluatedLocalDate"] as? String
        let today = Self.localDay(now)
        let retryNeeded = defaults.bool(forKey: dirtyKey) || evaluated != today ||
            (pending != nil && (completed?["requestId"] as? String != pending?["requestId"] as? String))
        if retryNeeded { scheduleCalendarRefresh(retry); return }
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now)) ?? now.addingTimeInterval(24 * 3600)
        let next = completed?["nextReviewAt"] as? String ?? template["nextReviewAt"] as? String
        let iso = ISO8601DateFormatter(), fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let due = next.flatMap { fractional.date(from: $0) ?? iso.date(from: $0) }
        let lastStamp = pendingPlan?["now"] as? String ?? state["lastNow"] as? String
        let last = lastStamp.flatMap { fractional.date(from: $0) ?? iso.date(from: $0) }
        if let due, due <= now, last.map({ $0 < due }) ?? true {
            scheduleCalendarRefresh(retry)
        } else {
            scheduleCalendarRefresh(due.map { $0 > now ? min($0, tomorrow) : tomorrow } ?? tomorrow)
        }
    }

    private static func localDay(_ now: Date) -> String {
        let date = DateFormatter()
        date.locale = Locale(identifier: "en_US_POSIX"); date.calendar = Calendar(identifier: .gregorian)
        date.timeZone = .current; date.dateFormat = "yyyy-MM-dd"
        return date.string(from: now)
    }

    func dailyGrantChanged() {
        if defaults.bool(forKey: armedKey), let key = authorizedGoal, let state = try? read(),
           let t = state["template"] as? [String: Any], let pair = try? pairedMac().1,
           BackgroundReviewAdmission.matches(state, template: t, pair: pair), dailyScope(t, key: key) {
            defaults.set(key, forKey: dailyWakeGoal)
            nextCalendarRefresh()
        } else {
            if defaults.string(forKey: dailyWakeGoal) != nil { calendarRefreshExpired() }
            defaults.removeObject(forKey: dailyWakeGoal)
            scheduleCalendarRefresh(nil)
        }
    }

    func calendarRefresh(_ completion: @escaping (Bool) -> Void) {
        guard UIApplication.shared.applicationState == .background, let key = authorizedGoal,
              defaults.string(forKey: dailyWakeGoal) == key, defaults.bool(forKey: armedKey) else { completion(false); return }
        // Resubmit first so suspension, lock, network failure or an unfinished DSH ticket can recover.
        scheduleCalendarRefresh(Date(timeIntervalSinceNow: 15 * 60))
        guard UIApplication.shared.isProtectedDataAvailable, let state = try? read(), let pair = try? pairedMac().1 else { completion(false); return }
        guard let template = state["template"] as? [String: Any], BackgroundReviewAdmission.matches(state, template: template, pair: pair),
              dailyScope(template, key: key) else { scheduleCalendarRefresh(nil); completion(false); return }
        observed { [weak self] in
            guard let self else { completion(false); return }
            completion(!self.defaults.bool(forKey: self.dirtyKey))
        }
    }

    func calendarRefreshExpired() {
        drainGeneration += 1
        worker?.cancel()
    }

    func disarm() {
        scheduleCalendarRefresh(nil)
        defaults.removeObject(forKey: dailyWakeGoal)
        defaults.set(false, forKey: armedKey)
        drainGeneration += 1
        worker?.cancel()
    }
    func consentChanged() {
        disarm(); discardScope()
    }
    private func discardScope() {
        defaults.set(UUID().uuidString, forKey: "along.health.backgroundEpoch.v1")
        removeState(); defaults.removeObject(forKey: dirtyKey); defaults.removeObject(forKey: observedTypesKey)
        configureObservers()
    }
    func configureObservers() {
        if usesEventProtocol() { reader.stopObserving(); observations = []; return }
        let typed = Set((defaults.stringArray(forKey: observedTypesKey) ?? []).compactMap(HealthMetric.init(rawValue:)))
        let desired = authorizedGoal == nil ? Set<HealthMetric>() : nativeSelection.intersection(typed)
        if desired != observations {
            observations = desired
            reader.observeChanges(desired) { [weak self] completion in
                Task { @MainActor in
                    guard let self else { completion(); return }
                    self.observed(completion)
                }
            }
            reader.updateBackgroundDelivery(desired)
        }
    }
    func foregroundStarted() { disarm() }
    func protectedDataAvailable() {
        if UIApplication.shared.applicationState == .background && defaults.bool(forKey: dirtyKey) { observed({}) }
    }
    private func observed(_ completion: @escaping () -> Void) {
        guard authorizedGoal != nil, UIApplication.shared.applicationState == .background else { completion(); return }
        defaults.set(true, forKey: dirtyKey)
        guard defaults.bool(forKey: armedKey), UIApplication.shared.isProtectedDataAvailable else { completion(); return }
        completions.append(completion)
        drain()
    }
    private func drain() {
        guard worker == nil, !completions.isEmpty else { return }
        let generation = drainGeneration
        worker = Task {
            // Each callback is completed after its work or after the durable foreground retry is retained.
            while !completions.isEmpty {
                let batch = completions; completions.removeAll()
                if generation == drainGeneration && !Task.isCancelled {
                    do { try await deliver(generation) } catch { /* A fresh foreground read and the stored request recover failures. */ }
                }
                if generation == drainGeneration, defaults.string(forKey: dailyWakeGoal) != nil { nextCalendarRefresh() }
                batch.forEach { $0() }
                if Task.isCancelled { break }
            }
            worker = nil
            drain()
        }
    }
    private func mayDeliver(_ generation: Int, goalKey: String) -> Bool {
        !Task.isCancelled && generation == drainGeneration && defaults.bool(forKey: armedKey) &&
            UIApplication.shared.applicationState == .background && UIApplication.shared.isProtectedDataAvailable && authorizedGoal == goalKey
    }
    private func deliver(_ generation: Int) async throws {
        var state = try read()
        let (connection, pair) = try pairedMac()
        guard var template = state["template"] as? [String: Any], let key = authorizedGoal,
              BackgroundReviewAdmission.valid(template, goalKey: key), BackgroundReviewAdmission.matches(state, template: template, pair: pair),
              template["paused"] as? Bool != true, mayDeliver(generation, goalKey: key) else { return }
        let selected = Set((template["selectedTypes"] as? [String] ?? []).compactMap(HealthMetric.init(rawValue:))).intersection(nativeSelection)
        guard !selected.isEmpty else { return }
        if let planning = template["planning"] as? [String: Any], planning["dailyDelegation"] != nil,
           !dailyScope(template, key: key) { return }
        let comparison = defaults.bool(forKey: "along.health.comparisonHistory.v1") && template["comparisonHistoryAllowed"] as? Bool == true
        let summary = try await reader.read(selected, requestPermission: false, includeContext: true, includeComparisonHistory: comparison)
        guard summary.hasReadableValue, mayDeliver(generation, goalKey: key), try pairedMac().1 == pair else { return }
        var snapshot = summary.browserSnapshot(contextReviewAllowed: true, comparisonHistoryAllowed: comparison)
        snapshot["backgroundReviewAllowed"] = true; snapshot["backgroundReviewGoalKey"] = key
        let now = Date(), zone = TimeZone.current
        let localDate = Self.localDay(now)
        let clock = ["now": ISO8601DateFormatter().string(from: now), "timezone": zone.identifier, "localDate": localDate]
        var pending = state["pending"] as? [String: Any]
        var lineage: [String: Any] = [:]
        if let old = pending, old["state"] as? String == "accepted" {
            guard let oldID = old["requestId"] as? String, let request = old["request"] as? [String: Any],
                  var facts = request["snapshot"] as? [String: Any], let oldPlan = facts.removeValue(forKey: "planning") as? [String: Any],
                  let oldDay = oldPlan["localDate"] as? String, var currentPlan = template["planning"] as? [String: Any] else { return }
            var completed = state["completed"] as? [String: Any]
            if completed?["requestId"] as? String != oldID {
                let run = try await callHost(connection, path: "/super-agent/goals/status", body: ["runtime": "dsh-superagent", "requestId": oldID, "contextReview": true])
                guard mayDeliver(generation, goalKey: key), try pairedMac().1 == pair else { return }
                if oldDay < localDate, dailyScope(template, key: key),
                   let grant = currentPlan["dailyDelegation"] as? [String: Any],
                   let blocked = BackgroundReviewAdmission.priorBlocked(run, id: oldID, day: oldDay, grant: grant) {
                    // Keep the DSH record and its ID, but never use its rejected output as the baseline.
                    state["lastBlocked"] = blocked
                } else {
                    guard let receipt = try await completionReceipt(run, id: oldID, day: oldDay, template: template, key: key,
                        generation: generation, pair: pair, types: selected) else { return }
                    completed = receipt
                    state["completed"] = receipt; try write(state)
                }
            }
            if completed?["requestId"] as? String == oldID {
                let due: Any = completed?["nextReviewAt"] as? String as Any? ?? NSNull()
                currentPlan["previous"] = facts
                template["planning"] = currentPlan
                template["evaluatedLocalDate"] = oldDay; template["nextReviewAt"] = due
                lineage = ["baseline": facts, "previousRequestId": oldID, "evaluatedLocalDate": oldDay, "nextReviewAt": due]
            }
            // Keep the old accepted receipt until its replacement can be durably recorded.
            pending = nil
        }
        if pending == nil {
            if lineage.isEmpty, let last = state["lastFacts"] as? [String: Any],
               BackgroundReviewAdmission.covered(state, date: localDate, now: now, nextReviewAt: template["nextReviewAt"] as? String),
               let changes = try sharedFunction("healthContextChanges", [last, snapshot]).toArray(), changes.isEmpty {
                defaults.set(false, forKey: dirtyKey); return
            }
            let id = "along-review-" + UUID().uuidString.lowercased()
            let value = try sharedFunction("buildBackgroundReviewRequest", [template, snapshot, id, clock])
            if value.isNull { defaults.set(false, forKey: dirtyKey); return }
            guard let request = value.toDictionary() as? [String: Any], request["requestId"] as? String == id,
                  request["runtime"] as? String == "dsh-superagent", let version = template["version"] as? String else { throw AgentBridgeError.invalidConfiguration }
            pending = lineage.merging(["requestId": id, "version": version, "goalKey": key, "request": request, "state": "uncertain"]) { _, new in new }
            state["pending"] = pending; state.removeValue(forKey: "completed"); try write(state)
        }
        guard let id = pending?["requestId"] as? String, let request = pending?["request"] as? [String: Any],
              mayDeliver(generation, goalKey: key), try pairedMac().1 == pair else { return }
        let response = try await callHost(connection, path: "/super-agent/goals", body: request)
        guard let run = response["run"] as? [String: Any], run["actual"] as? Bool == true, run["requestId"] as? String == id,
              run["runtime"] as? String == "dsh-superagent", mayDeliver(generation, goalKey: key), try pairedMac().1 == pair else { return }
        pending?["state"] = "accepted"; state["pending"] = pending; try write(state)
        if let receipt = try await completionReceipt(run, id: id, day: localDate, template: template, key: key,
            generation: generation, pair: pair, types: selected) {
            state["completed"] = receipt; try write(state)
        }
        defaults.set(false, forKey: dirtyKey)
    }

    private func completionReceipt(_ run: [String: Any], id: String, day: String, template: [String: Any],
                                   key: String, generation: Int, pair: String, types: Set<HealthMetric>) async throws -> [String: Any]? {
        guard mayDeliver(generation, goalKey: key), try pairedMac().1 == pair,
              run["actual"] as? Bool == true, run["runtime"] as? String == "dsh-superagent", run["requestId"] as? String == id,
              run["status"] as? String == "done", let ticket = run["ticket"] as? [String: Any], let ticketID = ticket["id"] as? String, !ticketID.isEmpty,
              let result = run["result"] as? [String: Any], let assessment = result["reassessment"] as? [String: Any],
              assessment["basedOnRevision"] as? String == id else { return nil }
        if day == Self.localDay(Date()), let plan = template["planning"] as? [String: Any], let grant = plan["dailyDelegation"] as? [String: Any] {
            guard dailyScope(template, key: key), let input = run["input"] as? [String: Any], let snapshot = input["snapshot"] as? [String: Any],
                  let runPlan = snapshot["planning"] as? [String: Any], let issued = runPlan["dailyDelegation"] as? [String: Any],
                  NSDictionary(dictionary: grant).isEqual(to: issued), runPlan["revisionId"] as? String == id,
                  runPlan["localDate"] as? String == day, runPlan["timezone"] as? String == TimeZone.current.identifier,
                  await deliverDailyResult(run, key, types.map(\.rawValue)), mayDeliver(generation, goalKey: key), try pairedMac().1 == pair
            else { return nil }
        }
        return ["requestId": id, "nextReviewAt": assessment["nextReviewAt"] as? String as Any? ?? NSNull()]
    }

    private func callHost(_ connection: [String: String], path: String, body: [String: Any]) async throws -> [String: Any] {
        var input = connection.reduce(into: [String: Any]()) { $0[$1.key] = $1.value }
        input["path"] = path; input["body"] = body
        return try await AlongWebView.Coordinator.agentRequest(input, background: true)
    }

    func bridgeAction(_ action: String, value: [String: Any]) throws -> [String: Any] {
        let enabled = authorizedGoal != nil
        if action == "disarm" {
            disarm()
            return ["enabled": enabled]
        }
        if action == "replace" {
            // A previously enqueued WK message can arrive just after suspension. It must
            // never erase an acknowledged job for the exact same scope, nor arm a new scope.
            if UIApplication.shared.applicationState == .background,
               let goals = value["goals"] as? [[String: Any]], goals.count == 1, let key = authorizedGoal,
               BackgroundReviewAdmission.valid(goals[0], goalKey: key),
               let pair = try? pairedMac().1, let old = try? read(),
               BackgroundReviewAdmission.matches(old, template: goals[0], pair: pair) {
                let previous = old["template"] as? [String: Any]
                if (previous?["paused"] as? Bool == true) != (goals[0]["paused"] as? Bool == true) { disarm() }
                return ["enabled": enabled]
            }
            // Invalidate first: a bad or interrupted replacement cannot leave the previous scope armed.
            disarm()
            var committed = false
            defer { if !committed { discardScope() } }
            guard UIApplication.shared.applicationState != .background, let key = authorizedGoal,
                  let goals = value["goals"] as? [[String: Any]], goals.count == 1 else {
                return ["enabled": enabled]
            }
            var template = goals[0]
            guard BackgroundReviewAdmission.valid(template, goalKey: key),
                  let types = template["selectedTypes"] as? [String], Set(types).isSubset(of: Set(nativeSelection.map(\.rawValue))),
                  let planning = template["planning"] as? [String: Any],
                  let clean = try sharedFunction("cleanPlanningContext", [planning]).toDictionary() as? [String: Any]
            else { throw AgentBridgeError.invalidConfiguration }
            template["planning"] = clean
            let (_, pair) = try pairedMac(), old = try read()
            var state = BackgroundReviewAdmission.matches(old, template: template, pair: pair) ? old : [:]
            state["pair"] = pair; state["template"] = template
            try write(state)
            defaults.set(types, forKey: observedTypesKey)
            defaults.set(true, forKey: armedKey)
            dailyGrantChanged()
            committed = true
            configureObservers()
            return ["enabled": true]
        }
        guard action == "pending" || action == "ack" else { throw AgentBridgeError.invalidConfiguration }
        guard let key = authorizedGoal, UIApplication.shared.applicationState != .background else { return ["enabled": enabled, "runs": []] }
        let (_, pair) = try pairedMac()
        var state = try read()
        guard let template = state["template"] as? [String: Any], BackgroundReviewAdmission.valid(template, goalKey: key),
              BackgroundReviewAdmission.matches(state, template: template, pair: pair), let pending = state["pending"] as? [String: Any]
        else { return ["enabled": true, "runs": []] }
        if action == "pending" {
            let eligible = value["goalKey"] as? String == key && value["version"] as? String == pending["version"] as? String
            return ["enabled": true, "runs": eligible ? [pending] : []]
        }
        if value["goalKey"] as? String == key, value["version"] as? String == pending["version"] as? String,
           value["requestId"] as? String == pending["requestId"] as? String {
            if let request = pending["request"] as? [String: Any], var last = request["snapshot"] as? [String: Any] {
                let planning = last.removeValue(forKey: "planning") as? [String: Any]
                state["lastLocalDate"] = planning?["localDate"]
                state["lastNow"] = planning?["now"]
                state["lastFacts"] = last
            }
            state.removeValue(forKey: "pending"); try write(state)
        }
        return ["enabled": true]
    }
}

@MainActor final class HealthDeliveryAppDelegate: NSObject, UIApplicationDelegate {
    private var awaitingInitialForeground = true
    private let dailyRefreshID = "com.artstur.AlongHealth.daily-review"
    private func schedule(_ date: Date?) {
        guard let date else { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: dailyRefreshID); return }
        let request = BGAppRefreshTaskRequest(identifier: dailyRefreshID)
        request.earliestBeginDate = date
        do { try BGTaskScheduler.shared.submit(request) } catch { /* User or system can disable Background App Refresh; foreground still recovers. */ }
    }

    private func handle(_ task: BGTask) {
        let reviews = BackgroundHealthReviews.shared
        var completed = false
        func finish(_ success: Bool) {
            guard !completed else { return }
            completed = true; task.setTaskCompleted(success: success)
        }
        task.expirationHandler = { Task { @MainActor in
            guard !completed else { return }
            reviews.calendarRefreshExpired(); finish(false)
        } }
        reviews.calendarRefresh { success in finish(success) }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        EventTaskNotifications.shared.received(token:token)
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = EventTaskNotifications.shared
        let reviews = BackgroundHealthReviews.shared
        BGTaskScheduler.shared.register(forTaskWithIdentifier: dailyRefreshID, using: .main) { [weak self] task in
            Task { @MainActor in
                guard let self else { task.setTaskCompleted(success: false); return }
                self.handle(task)
            }
        }
        reviews.usesEventProtocol = { HealthEventDelivery.shared.enabled }
        reviews.scheduleCalendarRefresh = { [weak self] date in self?.schedule(date) }
        reviews.permitsDailyReview = { grant, key, types in DailyHealthReminders.permitsBackground(grant, goalKey: key, selectedTypes: types) }
        reviews.deliverDailyResult = { run, key, types in await DailyHealthReminders.receivedInBackground(run, goalKey: key, selectedTypes: types) }
        if application.applicationState == .active { enterForeground() }
        reviews.configureObservers()
        HealthEventDelivery.shared.configureObservers()
        NotificationCenter.default.addObserver(self, selector: #selector(enterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(unlocked), name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
        return true
    }
    @objc private func enterForeground() {
        awaitingInitialForeground = false
        BackgroundHealthReviews.shared.foregroundStarted()
        HealthEventDelivery.shared.request()
    }
    @objc private func becameActive() { if awaitingInitialForeground { enterForeground() } }
    @objc private func unlocked() { BackgroundHealthReviews.shared.protectedDataAvailable(); HealthEventDelivery.shared.request() }
}

// New event protocol: a protected durable outbox shared by foreground and HealthKit background callbacks.
// Credentials remain in Keychain. A stored binding hash prevents delivery after re-pairing to another identity.
@MainActor final class HealthEventDelivery {
    static let shared = HealthEventDelivery()
    private let reader = HealthKitReader(), defaults = UserDefaults.standard
    private let enabledKey = "along.health.events.binding.v1", dirtyKey = "along.health.events.dirty.v1"
    private var worker: Task<Void, Never>?
    private var callbacks: [() -> Void] = []
    private var selection: Set<HealthMetric> = []
    var enabled: Bool { defaults.string(forKey: enabledKey) != nil }
    private var selected: Set<HealthMetric> {
        guard defaults.bool(forKey: "along.health.contextReview.v1") else { return [] }
        return Set((defaults.stringArray(forKey: "along.health.selectedTypes") ?? []).compactMap(HealthMetric.init(rawValue:)))
    }
    private func connectionHash(_ c: [String: String]) throws -> String {
        guard let seed = AlongConnectionStore.scopeSeed(c) else { throw AgentBridgeError.invalidConfiguration }
        return SHA256.hash(data: Data(seed.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func connection() throws -> ([String: String], String) {
        guard let c = AlongConnectionStore.load() else { throw AgentBridgeError.invalidConfiguration }
        return (c, try connectionHash(c))
    }
    // Only a valid local pinned credential can identify the same Mac at another
    // transport. Public PKI authenticates an origin, not this paired Mac.
    private func localCredential(_ c: [String: String]) -> String? {
        guard (c["trustPolicy"] ?? AlongConnectionStore.legacyPinPolicy) == AlongConnectionStore.legacyPinPolicy,
              let base = c["baseURL"], let host = URLComponents(string: base)?.host,
              AlongConnectionStore.trustPolicy(forHost: host) == AlongConnectionStore.legacyPinPolicy,
              let pin = c["fingerprint"], pin.count == 64, pin.allSatisfy(\.isHexDigit),
              let token = c["token"], token.count == 64, token.allSatisfy(\.isHexDigit) else { return nil }
        return SHA256.hash(data: Data([AlongConnectionStore.legacyPinPolicy, pin, token].joined(separator: "\n").utf8))
            .map { String(format: "%02x", $0) }.joined()
    }
    private func owns(_ state: [String: Any], connection c: [String: String], hash: String) -> Bool {
        guard let identity = state["binding"] as? String, defaults.string(forKey: enabledKey) == identity else { return false }
        if identity == hash { return true }
        if workspaceHandoffRecord(state, connection: c) != nil { return true }
        guard let proof = state["verifiedLocalTransports"] as? [String: Any],
              proof["identity"] as? String == identity,
              let credential = localCredential(c), proof["credential"] as? String == credential,
              let transports = proof["hashes"] as? [String], transports.contains(hash) else { return false }
        return true
    }
    // Called by the native connection-save bridge before replacing its Keychain
    // value. Never infer an old transport from an opaque binding hash.
    func saveConnection(_ value: [String: Any]) async throws -> [String: Any] {
        guard AlongConnectionStore.permitsPairedTransport(value), let next = AlongConnectionStore.clean(value) else { throw AgentBridgeError.invalidConfiguration }
        if let current = AlongConnectionStore.load(), current["baseURL"] != next["baseURL"],
           let credential = localCredential(current), credential == localCredential(next) {
            let oldHash = try connectionHash(current), nextHash = try connectionHash(next)
            let state = try load(createDirectory: false)
            if owns(state, connection: current, hash: oldHash), let user = state["user"] as? String, !user.isEmpty {
                let revision = AlongConnectionStore.saveRevision
                let before = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
                let status = try await call(next, path: "/connection/status", body: ["runtime": "dsh-superagent"])
                guard status["eventProtocol"] as? Int == 1, status["ready"] as? Bool == true,
                      status["userId"] as? String == user, AlongConnectionStore.load() == current,
                      AlongConnectionStore.saveRevision == revision,
                      defaults.string(forKey: enabledKey) == state["binding"] as? String,
                      try JSONSerialization.data(withJSONObject: load(createDirectory: false), options: [.sortedKeys]) == before
                else { throw AgentBridgeError.invalidConfiguration }
                var migrated = state
                let previousProof = state["verifiedLocalTransports"] as? [String: Any]
                let oldSeed = AlongConnectionStore.scopeSeed(current)!
                let notificationScope = previousProof?["notificationScope"] as? String ?? SHA256.hash(data: Data([oldSeed, user].joined(separator: "\n").utf8)).map { String(format: "%02x", $0) }.joined()
                migrated["verifiedLocalTransports"] = ["identity": state["binding"]!, "credential": credential,
                    "hashes": [oldHash, nextHash], "notificationScope": notificationScope,
                    "webMigration": ["fromBaseURL": current["baseURL"]!, "fromBindingScopeId": current["bindingScopeId"] ?? "",
                        "toBaseURL": next["baseURL"]!, "toBindingScopeId": next["bindingScopeId"] ?? "", "userId": user]]
                // Atomic queue commit precedes Keychain replacement. Both old and
                // verified new transports work if power or the Keychain write fails.
                try save(migrated)
            }
        }
        guard let saved = AlongConnectionStore.save(value) else { throw AgentBridgeError.invalidConfiguration }
        return connectionForWeb(saved)
    }
    // Tokenless evidence is returned only to the built-in connection bridge. Its
    // source is the atomic, authenticated migration record, never a JS claim.
    func connectionForWeb(_ c: [String: String]) -> [String: Any] {
        var result: [String: Any] = c
        if let state = try? load(createDirectory: false), let record = workspaceHandoffRecord(state, connection: c),
           let migration = record["webMigration"] as? [String: Any] {
            result["workspaceHandoff"] = migration
        }
        guard let hash = try? connectionHash(c), let state = try? load(createDirectory: false),
              owns(state, connection: c, hash: hash),
              let proof = state["verifiedLocalTransports"] as? [String: Any],
              let migration = proof["webMigration"] as? [String: String],
              migration["toBaseURL"] == c["baseURL"], migration["toBindingScopeId"] == c["bindingScopeId"],
              migration["userId"] == state["user"] as? String else { return result }
        result["transportMigration"] = migration
        return result
    }
    func notificationScope(_ c: [String: String], user: String) -> String? {
        if let state = try? load(createDirectory: false), state["user"] as? String == user,
           let record = workspaceHandoffRecord(state, connection: c), let scope = record["notificationScope"] as? String { return scope }
        guard let hash = try? connectionHash(c), let state = try? load(createDirectory: false),
              owns(state, connection: c, hash: hash), state["user"] as? String == user,
              let proof = state["verifiedLocalTransports"] as? [String: Any],
              let scope = proof["notificationScope"] as? String, scope.count == 64 else { return nil }
        return scope
    }
    private func workspaceHandoffRecord(_ state: [String: Any], connection c: [String: String]) -> [String: Any]? {
        guard let record = state["workspaceHandoff"] as? [String: Any],
              ["prepared", "committed"].contains(record["phase"] as? String ?? ""),
              record["binding"] as? String == state["binding"] as? String,
              record["userId"] as? String == state["user"] as? String,
              defaults.string(forKey: enabledKey) == state["binding"] as? String,
              c["trustPolicy"] == AlongConnectionStore.systemTrustPolicy,
              let token = c["token"], WorkspaceHandoffProof.hash(token) == record["targetCredentialSHA256"] as? String,
              c["baseURL"] == record["targetBaseURL"] as? String,
              c["bindingScopeId"] == record["targetBindingScopeId"] as? String,
              WorkspaceHandoffProof.isHash(record["notificationScope"] as? String) else { return nil }
        return record
    }
    func prepareWorkspaceHandoff(targetOrigin: String) throws -> [String: Any] {
        let (c, hash) = try connection()
        var state = try load(createDirectory: false)
        guard c["trustPolicy"] == AlongConnectionStore.legacyPinPolicy,
              AlongConnectionStore.trustPolicy(forHost: URLComponents(string: targetOrigin)?.host ?? "") == AlongConnectionStore.systemTrustPolicy,
              AlongConnectionStore.hostAccepted(URLComponents(string: targetOrigin)?.host ?? ""),
              WorkspaceHandoffProof.origin(targetOrigin) == targetOrigin,
              let source = c["baseURL"].flatMap(WorkspaceHandoffProof.origin), let token = c["token"], let pin = c["fingerprint"],
              owns(state, connection: c, hash: hash), let user = state["user"] as? String,
              state["workspaceHandoff"] == nil else { throw WorkspaceHandoffError.invalidState }
        if let prior = state["workspaceHandoffChallenge"] as? [String: Any], prior["purpose"] as? String == WorkspaceHandoffProof.purpose,
           prior["sourceOrigin"] as? String == source, prior["targetOrigin"] as? String == targetOrigin,
           prior["sourceFingerprint"] as? String == pin, prior["sourceCredentialSHA256"] as? String == WorkspaceHandoffProof.hash(token),
           prior["userId"] as? String == user, WorkspaceHandoffProof.isHash(prior["nonce"] as? String),
           let expires = prior["expiresAt"] as? Int, expires > Int(Date().timeIntervalSince1970) { return prior }
        var nonce = Data(count: 32)
        guard nonce.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { throw WorkspaceHandoffError.invalidState }
        let now = Int(Date().timeIntervalSince1970)
        let challenge: [String: Any] = ["purpose": WorkspaceHandoffProof.purpose, "sourceOrigin": source, "targetOrigin": targetOrigin,
            "sourceFingerprint": pin, "sourceCredentialSHA256": WorkspaceHandoffProof.hash(token), "userId": user,
            "nonce": nonce.map { String(format: "%02x", $0) }.joined(), "createdAt": now, "expiresAt": now + 86400]
        state["workspaceHandoffChallenge"] = challenge; try save(state)
        return challenge
    }
    func commitWorkspaceHandoff(_ offer: [String: Any]) async throws -> [String: Any] {
        guard Set(offer.keys) == ["format", "connection", "proof", "manifestUTF8"], offer["format"] as? String == "along-native-workspace-handoff/v1",
              let manifestText = offer["manifestUTF8"] as? String,
              let offered = offer["connection"] as? [String: Any], Set(offered.keys) == ["baseURL", "token", "runtime"],
              let next = AlongConnectionStore.clean(offered), next["trustPolicy"] == AlongConnectionStore.systemTrustPolicy,
              let proof = offer["proof"] as? [String: Any] else { throw WorkspaceHandoffError.invalidProof }
        let (current, hash) = try connection()
        var state = try load(createDirectory: false)
        if let record = workspaceHandoffRecord(state, connection: current),
           let originalProof = record["proof"] as? [String: Any],
           ["algorithm", "payload", "certificateDER", "signature"].allSatisfy({ originalProof[$0] as? String == proof[$0] as? String }),
           Set(originalProof.keys) == Set(proof.keys), current == next {
            try await recoverWorkspaceHandoff(); return connectionForWeb(next)
        }
        guard current["trustPolicy"] == AlongConnectionStore.legacyPinPolicy, let pin = current["fingerprint"],
              let token = current["token"], let user = state["user"] as? String, owns(state, connection: current, hash: hash),
              let challenge = state["workspaceHandoffChallenge"] as? [String: Any],
              let expires = challenge["expiresAt"] as? Int, expires > Int(Date().timeIntervalSince1970),
              state["workspaceHandoff"] == nil else { throw WorkspaceHandoffError.invalidState }
        let claims = try WorkspaceHandoffProof.verifySignature(proof, sourcePin: pin)
        let manifest = try WorkspaceHandoffProof.manifest(manifestText, claims: claims)
        guard claims["sourceOrigin"] == current["baseURL"].flatMap(WorkspaceHandoffProof.origin),
              claims["sourceCredentialSHA256"] == WorkspaceHandoffProof.hash(token), claims["userId"] == user,
              claims["targetOrigin"] == next["baseURL"].flatMap(WorkspaceHandoffProof.origin),
              claims["targetCredentialSHA256"] == next["token"].map(WorkspaceHandoffProof.hash),
              claims["nonce"] == challenge["nonce"] as? String, claims["targetOrigin"] == challenge["targetOrigin"] as? String,
              challenge["sourceCredentialSHA256"] as? String == claims["sourceCredentialSHA256"] else { throw WorkspaceHandoffError.invalidProof }
        let revision = AlongConnectionStore.saveRevision
        let permission = defaults.bool(forKey: "along.health.contextReview.v1")
        let selection = defaults.stringArray(forKey: "along.health.selectedTypes")
        let status = try await call(next, path: "/workspace-handoff/status", body: [:])
        guard WorkspaceHandoffProof.matchesStatus(status, claims: claims, manifest: manifest), AlongConnectionStore.load() == current,
              AlongConnectionStore.saveRevision == revision,
              defaults.bool(forKey: "along.health.contextReview.v1") == permission,
              defaults.stringArray(forKey: "along.health.selectedTypes") == selection else { throw WorkspaceHandoffError.invalidState }
        // Re-read after the network wait. Legitimate append/ACK changes are retained, not used as
        // a reason to freeze the entire queue or overwrite it with a stale snapshot.
        state = try load(createDirectory: false)
        guard owns(state, connection: current, hash: hash), state["user"] as? String == user,
              (state["workspaceHandoffChallenge"] as? [String: Any])?["nonce"] as? String == claims["nonce"],
              state["workspaceHandoff"] == nil else { throw WorkspaceHandoffError.invalidState }
        let id = claims["migrationId"]!
        try WorkspaceHandoffVault.save(["source": current, "target": next], id: id)
        let oldScope = notificationScope(current, user: user) ?? WorkspaceHandoffProof.hash([AlongConnectionStore.scopeSeed(current)!, user].joined(separator: "\n"))
        let web: [String: Any] = ["purpose": WorkspaceHandoffProof.purpose, "migrationId": id,
            "fromBaseURL": current["baseURL"]!, "toBaseURL": next["baseURL"]!, "fromBindingScopeId": current["bindingScopeId"]!,
            "toBindingScopeId": next["bindingScopeId"]!, "userId": user, "deviceId": claims["deviceId"]!,
            "manifestSHA256": claims["manifestSHA256"]!, "snapshotSHA256": claims["snapshotSHA256"]!,
            "syncPrefixSHA256": claims["syncPrefixSHA256"]!, "syncHighWaterMark": Int(claims["syncHighWaterMark"]!)!]
        state["workspaceHandoff"] = ["phase": "prepared", "migrationId": id, "binding": state["binding"]!, "userId": user,
            "targetCredentialSHA256": claims["targetCredentialSHA256"]!, "targetBaseURL": next["baseURL"]!,
            "targetBindingScopeId": next["bindingScopeId"]!, "notificationScope": oldScope, "proof": proof, "manifestUTF8": manifestText, "webMigration": web]
        try save(state) // durable authorization proof precedes replacement of the sole live connection.
        try await recoverWorkspaceHandoff()
        guard AlongConnectionStore.load() == next else { throw WorkspaceHandoffError.invalidState }
        return connectionForWeb(next)
    }
    func recoverWorkspaceHandoff(onlyIfAlreadyTarget: Bool = false) async throws {
        var state = try load(createDirectory: false)
        guard var record = state["workspaceHandoff"] as? [String: Any], record["phase"] as? String == "prepared",
              let id = record["migrationId"] as? String else { return }
        let secrets = try WorkspaceHandoffVault.load(id)
        guard let source = secrets["source"] as? [String: String], let target = secrets["target"] as? [String: String],
              let current = AlongConnectionStore.load(), current == source || current == target,
              let proof = record["proof"] as? [String: Any], let manifestText = record["manifestUTF8"] as? String,
              let pin = source["fingerprint"] else { throw WorkspaceHandoffError.invalidState }
        let claims = try WorkspaceHandoffProof.verifySignature(proof, sourcePin: pin, allowExpired: true)
        let manifest = try WorkspaceHandoffProof.manifest(manifestText, claims: claims)
        guard claims["migrationId"] == id, claims["userId"] == state["user"] as? String,
              claims["sourceCredentialSHA256"] == source["token"].map(WorkspaceHandoffProof.hash),
              claims["targetCredentialSHA256"] == target["token"].map(WorkspaceHandoffProof.hash),
              WorkspaceHandoffProof.origin(target["baseURL"]!) == claims["targetOrigin"],
              defaults.string(forKey: enabledKey) == state["binding"] as? String else { throw WorkspaceHandoffError.invalidState }
        if current == source {
            // A normal launch can render its original offline cache first. This option does
            // not change a connection; the full recovery below retains the live readiness,
            // connection generation, latest journal and ownership checks before committing.
            if onlyIfAlreadyTarget { return }
            let revision = AlongConnectionStore.saveRevision
            let status = try await call(target, path: "/workspace-handoff/status", body: [:])
            guard WorkspaceHandoffProof.matchesStatus(status, claims: claims, manifest: manifest), AlongConnectionStore.load() == source,
                  AlongConnectionStore.saveRevision == revision else { throw WorkspaceHandoffError.invalidState }
            state = try load(createDirectory: false)
            guard let latest = state["workspaceHandoff"] as? [String: Any], latest["migrationId"] as? String == id,
                  latest["phase"] as? String == "prepared", defaults.string(forKey: enabledKey) == state["binding"] as? String,
                  state["user"] as? String == claims["userId"] else { throw WorkspaceHandoffError.invalidState }
            record = latest
            guard AlongConnectionStore.save(target) == target else { throw WorkspaceHandoffError.secretUnavailable }
        }
        // Keychain may already have committed before a prior process exited. No new network
        // or re-pairing is needed to finish the authenticated local journal in that case.
        state = try load(createDirectory: false)
        guard AlongConnectionStore.load() == target,
              (state["workspaceHandoff"] as? [String: Any])?["migrationId"] as? String == id else { throw WorkspaceHandoffError.invalidState }
        record["phase"] = "committed"; state["workspaceHandoff"] = record
        state.removeValue(forKey: "workspaceHandoffChallenge"); try save(state)
    }
    private func stateURL(createDirectory: Bool = true) throws -> URL {
        let dir = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: createDirectory)
            .appendingPathComponent("AlongHealthEvents", isDirectory: true)
        if createDirectory {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            var excluded = dir, values = URLResourceValues(); values.isExcludedFromBackup = true; try excluded.setResourceValues(values)
        }
        return dir.appendingPathComponent("outbox.json")
    }
    private func load(createDirectory: Bool = true) throws -> [String: Any] {
        do {
            let data = try Data(contentsOf: stateURL(createDirectory: createDirectory))
            guard let state = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AgentBridgeError.invalidConfiguration }
            return state
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile { return [:] }
    }
    private func save(_ state: [String: Any]) throws {
        try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]).write(to: stateURL(), options: [.atomic, .completeFileProtection])
    }
    private func call(_ connection: [String: String], path: String, body: [String: Any]) async throws -> [String: Any] {
        var input = connection.reduce(into: [String: Any]()) { $0[$1.key] = $1.value }
        input["path"] = path; input["body"] = body
        return try await AlongWebView.Coordinator.agentRequest(input, background: UIApplication.shared.applicationState == .background,
            privateWorkspaceHandoffRequest: path == "/workspace-handoff/status")
    }
    // Read-only recovery proof for Build78's origin-less Web event binding. No health
    // samples, permissions, observers, delivery requests or outbox writes occur here.
    func cachedWorkspaceBinding(_ c: [String: String]) -> [String: String] {
        guard UIApplication.shared.isProtectedDataAvailable,
              let base = c["baseURL"], let token = c["token"], let scope = c["bindingScopeId"],
              AlongConnectionStore.bindingScopeId(baseURL: base, token: token) == scope,
              let seed = AlongConnectionStore.scopeSeed(c) else { return [:] }
        let hash = SHA256.hash(data: Data(seed.utf8)).map { String(format: "%02x", $0) }.joined()
        guard let state = try? load(createDirectory: false), owns(state, connection: c, hash: hash),
              let user = state["user"] as? String,
              user.range(of: #"^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$"#, options: .regularExpression) != nil else { return [:] }
        return ["baseURL": base, "bindingScopeId": scope, "userId": user]
    }
    func configure() async throws -> [String: Any] {
        let (c, hash) = try connection()
        let status = try await call(c, path: "/connection/status", body: ["runtime": "dsh-superagent"])
        guard status["eventProtocol"] as? Int == 1, status["ready"] as? Bool == true,
              let user = status["userId"] as? String, !user.isEmpty, try connection().0 == c else { throw AgentBridgeError.invalidConfiguration }
        var state = try load()
        if !owns(state, connection: c, hash: hash) || state["user"] as? String != user {
            // Keep an old outbox on disk for its original identity instead of sending it to the new one.
            if !state.isEmpty {
                let archived = try stateURL().deletingLastPathComponent().appendingPathComponent("previous-" + UUID().uuidString + ".json")
                try JSONSerialization.data(withJSONObject: state).write(to: archived, options: [.atomic, .completeFileProtection])
            }
            state = ["binding": hash, "user": user, "pending": []]
            try save(state)
        }
        defaults.set(state["binding"] as? String, forKey: enabledKey)
        BackgroundHealthReviews.shared.usesEventProtocol = { HealthEventDelivery.shared.enabled }
        BackgroundHealthReviews.shared.disarm()
        BackgroundHealthReviews.shared.configureObservers()
        configureObservers(); request()
        return ["enabled": true]
    }
    func configureObservers() {
        let desired = enabled ? selected : []
        guard desired != selection else { return }
        selection = desired
        reader.observeChanges(desired) { completion in
            Task { @MainActor in HealthEventDelivery.shared.request(completion) }
        }
        reader.updateBackgroundDelivery(desired)
    }
    func consentChanged() { configureObservers(); request() }
    func request(_ completion: @escaping () -> Void = {}) {
        guard enabled else { completion(); return }
        defaults.set(true, forKey: dirtyKey)
        guard UIApplication.shared.isProtectedDataAvailable else { completion(); return }
        callbacks.append(completion)
        guard worker == nil else { return }
        worker = Task {
            while !callbacks.isEmpty {
                let batch = callbacks; callbacks.removeAll()
                do { try await deliver() } catch { /* Durable queue and dirty marker recover on next execution opportunity. */ }
                batch.forEach { $0() }
            }
            worker = nil
        }
    }
    private func deliver() async throws {
        let (c, hash) = try connection()
        var state = try load()
        if (state["workspaceHandoff"] as? [String: Any])?["phase"] as? String == "prepared" { return }
        guard owns(state, connection: c, hash: hash), let identity = state["binding"] as? String,
              let user = state["user"] as? String else { return }
        let types = selected
        if !types.isEmpty {
            let summary = try await HealthDeviceDataCollector(reader: reader, types: types).collect()
            guard types == selected, try connection().0 == c else { return }
            // A configure/save may have run during the read. Preserve its durable
            // transport proof and do not write a stale in-memory queue over it.
            state = try load()
            guard owns(state, connection: c, hash: hash), state["binding"] as? String == identity,
                  state["user"] as? String == user else { return }
            let summaries = summary.eventSummaries()
            let content = try HealthEventOutbox.content(summaries)
            if state["lastContent"] as? String != content {
                let event: [String: Any] = ["event_id": "health-" + UUID().uuidString.lowercased(), "schema_version": "1",
                    "event_type": "along.health_summary_updated", "occurred_at": ISO8601DateFormatter().string(from: summary.capturedAt),
                    "timezone": TimeZone.current.identifier, "payload": ["event_type": "along.health_summary_updated", "summaries": summaries]]
                try DeviceEventQueue.append(event, to: &state, maxPending: Int.max)
                state["lastContent"] = content
                try save(state) // Never send an event that has not been committed locally.
            }
        }
        while let event = (state["pending"] as? [[String: Any]])?.first {
            guard types == selected, !types.isEmpty, try connection().0 == c else { return }
            if !HealthEventOutbox.permitted(event, types: types) {
                var held = state["held"] as? [[String: Any]] ?? []; held.append(event); state["held"] = held
                var pending = state["pending"] as? [[String: Any]] ?? []; pending.removeFirst(); state["pending"] = pending
                try save(state); continue
            }
            let receipt: [String: Any]
            do { receipt = try await call(c, path: "/events", body: event) }
            catch AgentBridgeError.receipt(let failure) {
                guard HealthEventOutbox.terminal(event, receipt: failure) else { throw AgentBridgeError.receipt(failure) }
                receipt = failure
            }
            // An ACK may arrive from the previous verified address. Re-read the
            // current identity and exact event; never overwrite a newer queue.
            state = try load()
            let (current, currentHash) = try connection()
            if state["workspaceHandoff"] != nil, try connectionHash(c) != currentHash { return }
            guard owns(state, connection: current, hash: currentHash), state["binding"] as? String == identity,
                  state["user"] as? String == user,
                  let first = (state["pending"] as? [[String: Any]])?.first,
                  try JSONSerialization.data(withJSONObject: first, options: [.sortedKeys]) == JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
            else { return }
            if HealthEventOutbox.terminal(event, receipt: receipt) {
                var held = state["held"] as? [[String: Any]] ?? []; held.append(["event": event, "receipt": receipt]); state["held"] = held
            } else if !HealthEventOutbox.acknowledged(event, by: receipt) { throw AgentBridgeError.invalidConfiguration }
            var pending = state["pending"] as? [[String: Any]] ?? []; pending.removeFirst(); state["pending"] = pending
            try save(state) // A failed save causes a safe same-id duplicate next time.
        }
        defaults.set(false, forKey: dirtyKey)
    }

}

// Pure Foundation contract, executed from the actual source by the native queue regression tests.
enum HealthEventOutbox {
    static func content(_ summaries: [[String: Any]]) throws -> String {
        let facts = summaries.map { row in row.filter { $0.key != "metric_version" } }
        let data = try JSONSerialization.data(withJSONObject: facts, options: [.sortedKeys])
        return data.base64EncodedString()
    }
    static func permitted(_ event: [String: Any], types: Set<HealthMetric>) -> Bool {
        let names: [HealthMetric: String] = [.steps: "steps", .workout: "workout", .activeEnergy: "active_energy", .weight: "weight",
            .restingHeartRate: "resting_heart_rate", .wristTemperature: "wrist_temperature", .sleep: "sleep"]
        let allowed = Set(types.compactMap { names[$0] })
        guard let payload = event["payload"] as? [String: Any], let summaries = payload["summaries"] as? [[String: Any]], !summaries.isEmpty else { return false }
        return summaries.allSatisfy { row in (row["type"] as? String).map { allowed.contains($0) } ?? false }
    }
    static func terminal(_ event: [String: Any], receipt: [String: Any]) -> Bool {
        DeviceEventQueue.disposition(event: event, receipt: receipt) == .held
    }
    static func acknowledged(_ event: [String: Any], by receipt: [String: Any]) -> Bool {
        DeviceEventQueue.disposition(event: event, receipt: receipt) == .acknowledged
    }
}
