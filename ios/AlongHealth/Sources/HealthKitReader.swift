import Foundation
import HealthKit
import JavaScriptCore
import CryptoKit
import UIKit

final class HealthKitReader {
    private let store = HKHealthStore()
    private var observers: [HKObserverQuery] = []

    func read(_ selection: Set<HealthMetric>, requestPermission: Bool = true, includeContext: Bool = true, includeComparisonHistory: Bool = false) async throws -> HealthSummary {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw ReaderError.unavailable
        }
        let ordered = HealthMetric.allCases.filter { selection.contains($0) }
        guard !ordered.isEmpty else { throw ReaderError.emptySelection }
        let types = Set<HKObjectType>(ordered.map(Self.sampleType))
        // This requests read access only for the boxes the person checked.
        if requestPermission {
            try await store.requestAuthorization(toShare: Set<HKSampleType>(), read: types)
        }

        let now = Date()
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

    private func recentWorkouts(now: Date, includeContext: Bool) async throws -> (minutes: Int?, count: Int?, summary: [String: Any]?, history: [String: Any]?) {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = .current
        let weekStart = calendar.dateInterval(of: .weekOfYear, for: now)!.start
        let todayStart = calendar.startOfDay(for: now)
        let yesterdayStart = calendar.date(byAdding: .day, value: -1, to: todayStart)!
        let recentStart = calendar.date(byAdding: .day, value: -6, to: todayStart)!
        let start = includeContext ? calendar.date(byAdding: .day, value: -27, to: todayStart)! : weekStart
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: .strictStartDate)
        let workouts = try await samples(of: .workoutType(), predicate: predicate).compactMap { $0 as? HKWorkout }
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
        let summary: [String: Any] = ["windowDays": 28, "weekStartAt": formatter.string(from: weekStart),
            "todayMinutes": Int(today.reduce(0.0) { $0 + $1.duration } / 60), "todayCount": today.count,
            "yesterdayMinutes": Int(yesterday.reduce(0.0) { $0 + $1.duration } / 60),
            "latestWorkoutAt": formatter.string(from: workouts.map(\.startDate).max()!), "patterns": patterns]
        return (weekMinutes, week.count, summary, history)
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
        let ranges = values.compactMap { sample -> DateInterval? in
            guard let sleep = sample as? HKCategorySample,
                  let stage = HKCategoryValueSleepAnalysis(rawValue: sleep.value),
                  HKCategoryValueSleepAnalysis.allAsleepValues.contains(stage) else { return nil }
            return sleep.startDate < sleep.endDate ? DateInterval(start: sleep.startDate, end: sleep.endDate) : nil
        }
        return window.summarize(ranges, includeHistory: includeHistory)
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
        guard let connection = AlongConnectionStore.load(), let base = connection["baseURL"], let pin = connection["fingerprint"], let token = connection["token"] else { throw AgentBridgeError.invalidConfiguration }
        let epoch = defaults.string(forKey: "along.health.backgroundEpoch.v1") ?? ""
        let digest = SHA256.hash(data: Data([base, pin, token, epoch].joined(separator: "\n").utf8)).map { String(format: "%02x", $0) }.joined()
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

    func disarm() {
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
        let comparison = defaults.bool(forKey: "along.health.comparisonHistory.v1") && template["comparisonHistoryAllowed"] as? Bool == true
        let summary = try await reader.read(selected, requestPermission: false, includeContext: true, includeComparisonHistory: comparison)
        guard summary.hasReadableValue, mayDeliver(generation, goalKey: key), try pairedMac().1 == pair else { return }
        var snapshot = summary.browserSnapshot(contextReviewAllowed: true, comparisonHistoryAllowed: comparison)
        snapshot["backgroundReviewAllowed"] = true; snapshot["backgroundReviewGoalKey"] = key
        let now = Date(), zone = TimeZone.current, date = DateFormatter()
        date.locale = Locale(identifier: "en_US_POSIX"); date.calendar = Calendar(identifier: .gregorian); date.timeZone = zone; date.dateFormat = "yyyy-MM-dd"
        let localDate = date.string(from: now)
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
                guard mayDeliver(generation, goalKey: key), try pairedMac().1 == pair,
                      run["actual"] as? Bool == true, run["runtime"] as? String == "dsh-superagent", run["requestId"] as? String == oldID,
                      run["status"] as? String == "done", let ticket = run["ticket"] as? [String: Any], let ticketID = ticket["id"] as? String, !ticketID.isEmpty,
                      let result = run["result"] as? [String: Any], let assessment = result["reassessment"] as? [String: Any],
                      assessment["basedOnRevision"] as? String == oldID else { return }
                completed = ["requestId": oldID, "nextReviewAt": assessment["nextReviewAt"] as? String as Any? ?? NSNull()]
                state["completed"] = completed; try write(state)
            }
            let due: Any = completed?["nextReviewAt"] as? String as Any? ?? NSNull()
            currentPlan["previous"] = facts
            template["planning"] = currentPlan
            template["evaluatedLocalDate"] = oldDay; template["nextReviewAt"] = due
            lineage = ["baseline": facts, "previousRequestId": oldID, "evaluatedLocalDate": oldDay, "nextReviewAt": due]
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
        defaults.set(false, forKey: dirtyKey)
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
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let reviews = BackgroundHealthReviews.shared
        if application.applicationState != .background { reviews.foregroundStarted() }
        reviews.configureObservers()
        NotificationCenter.default.addObserver(self, selector: #selector(enterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(unlocked), name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
        return true
    }
    @objc private func enterForeground() { BackgroundHealthReviews.shared.foregroundStarted() }
    @objc private func unlocked() { BackgroundHealthReviews.shared.protectedDataAvailable() }
}
