import CryptoKit
import Foundation
import UserNotifications

// A daily delegation is independent of the editable task layout. Its two notification
// identifiers stay stable when a later DSH assessment revises the same local day.
struct DailyReminderScope {
    let goalKey: String
    let localDate: String
    let zone: TimeZone

    init(_ value: [String: Any], now: Date = Date()) throws {
        guard let goalKey = value["goalKey"] as? String,
              goalKey == "health" || goalKey.range(of: #"^custom:[A-Za-z0-9_:-]{1,90}$"#, options: .regularExpression) != nil,
              let zoneName = value["timezone"] as? String, let zone = TimeZone(identifier: zoneName),
              let day = value["localDate"] as? String, Self.day(now, in: zone) == day else {
            throw AgentBridgeError.server("每日提醒的目标或本地日期无效")
        }
        self.goalKey = goalKey
        self.localDate = day
        self.zone = zone
    }

    static func day(_ date: Date, in zone: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = zone
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }

    static func date(_ raw: String?) -> Date? {
        guard let raw, raw.range(of: #"(Z|[+-][0-9]{2}:[0-9]{2})$"#, options: .regularExpression) != nil else { return nil }
        let parser = ISO8601DateFormatter()
        if let date = parser.date(from: raw) { return date }
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: raw)
    }

    static func hash(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }

    func identifier(_ topic: String) -> String { "along.daily." + Self.hash([goalKey, localDate, topic].joined(separator: "\n")) }

    func topic(of request: UNNotificationRequest) -> String? {
        guard let trigger = request.trigger as? UNCalendarNotificationTrigger, !trigger.repeats,
              request.content.userInfo["goalKey"] as? String == goalKey,
              let rid = request.content.userInfo["requestId"] as? String, !rid.isEmpty else { return nil }
        if let topic = request.content.userInfo["dailyTopic"] as? String, ["sleep", "workout"].contains(topic),
           request.content.userInfo["localDate"] as? String == localDate, request.identifier == identifier(topic) { return topic }
        // The earlier signed handoff used the normal plan identifier and this dated task ID.
        let taskID = "sleep-prep-" + localDate
        let prefix = goalKey == "health" ? "along.health-plan." : "along.custom-health-plan." + Self.hash(goalKey) + "."
        return request.content.userInfo["taskId"] as? String == taskID && request.identifier == prefix + Self.hash(taskID) ? "sleep" : nil
    }

    func verifiedActions(_ response: [String: Any], requestID: String, ticketID: String) throws -> ([String: Any], Set<String>, String) {
        let run = response["run"] as? [String: Any] ?? response
        guard run["actual"] as? Bool == true, run["runtime"] as? String == "dsh-superagent", run["status"] as? String == "done",
              run["requestId"] as? String == requestID, (run["ticket"] as? [String: Any])?["id"] as? String == ticketID,
              let input = run["input"] as? [String: Any], let snapshot = input["snapshot"] as? [String: Any], snapshot["contextReviewAllowed"] as? Bool == true,
              let planning = snapshot["planning"] as? [String: Any], planning["revisionId"] as? String == requestID,
              planning["localDate"] as? String == localDate, planning["timezone"] as? String == zone.identifier,
              let delegation = planning["dailyDelegation"] as? [String: Any], delegation["goalKey"] as? String == goalKey,
              let id = delegation["id"] as? String, !id.isEmpty, let delegated = delegation["topics"] as? [String],
              let selected = snapshot["selectedTypes"] as? [String], !delegated.isEmpty,
              Set(delegated).isSubset(of:["sleep","workout"]), Set(delegated).isSubset(of:Set(selected)),
              let result = run["result"] as? [String: Any], let assessment = result["reassessment"] as? [String: Any],
              assessment["basedOnRevision"] as? String == requestID, let actions = assessment["dailyActions"] as? [String: Any],
              actions["localDate"] as? String == localDate, let reason = actions["reason"] as? String, !reason.isEmpty else {
            throw AgentBridgeError.server("尚未取得这个目标今天已委托的真实 DSH 行动工单")
        }
        return (actions, Set(selected).intersection(delegated), id)
    }
}

@MainActor enum DailyHealthReminders {
    static let topics = ["sleep", "workout"]
    private static let center = UNUserNotificationCenter.current()
    private static let ledgerKey = "along.health.dailyReminderReceipts.v1"
    private static var generations: [String: Int] = [:]
    private static let mandateKey = "along.health.dailyMandates.v1"
    private static let appliedKey = "along.health.dailyApplied.v1"
    private static let revokedKey = "along.health.revokedDailyMandates.v1"
    private static var tail: Task<Void, Never>?

    private static func ledger() -> [String: [String: String]] {
        UserDefaults.standard.dictionary(forKey: ledgerKey) as? [String: [String: String]] ?? [:]
    }

    private static func remember(_ request: UNNotificationRequest, scope: DailyReminderScope, topic: String, date: Date, planTaskID: String?) {
        var rows = ledger().filter { row in
            guard let at = DailyReminderScope.date(row.value["scheduledFor"]) else { return false }
            return at > Date().addingTimeInterval(-3 * 86400)
        }
        rows[scope.identifier(topic)] = ["goalKey":scope.goalKey, "topic":topic, "planTaskId":planTaskID ?? "", "identifier": request.identifier, "requestId": request.content.userInfo["requestId"] as? String ?? "",
            "scheduledFor": ISO8601DateFormatter().string(from: date)]
        UserDefaults.standard.set(rows, forKey: ledgerKey)
    }

    nonisolated static func owns(_ request: UNNotificationRequest, goalKey: String) -> Bool {
        let info = request.content.userInfo
        guard info["goalKey"] as? String == goalKey, let topic = info["dailyTopic"] as? String, topicsForOwnership.contains(topic),
              let day = info["localDate"] as? String else { return false }
        return request.identifier == "along.daily." + DailyReminderScope.hash([goalKey,day,topic].joined(separator: "\n"))
    }
    private nonisolated static let topicsForOwnership: Set<String> = ["sleep", "workout"]

    static func cancel(_ value: [String: Any]) async throws -> [String: Any] {
        guard let key = value["goalKey"] as? String, key == "health" || key.range(of: #"^custom:[A-Za-z0-9_:-]{1,90}$"#, options: .regularExpression) != nil else { throw AgentBridgeError.invalidConfiguration }
        generations[key, default:0] += 1
        let defaults = UserDefaults.standard
        var mandates = defaults.dictionary(forKey: mandateKey) as? [String: String] ?? [:]
        var blocks = defaults.dictionary(forKey: revokedKey) as? [String: String] ?? [:]
        blocks[key] = value["delegationId"] as? String ?? mandates[key]
        if blocks[key] != nil { defaults.set(blocks, forKey: revokedKey) }
        mandates.removeValue(forKey: key)
        defaults.set(mandates, forKey: mandateKey)
        BackgroundHealthReviews.shared.dailyGrantChanged()
        return try await serialized {
            let pending = await center.pendingNotificationRequests().filter { owns($0, goalKey: key) }
            center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier))
            let remaining = await center.pendingNotificationRequests().filter { owns($0, goalKey: key) }
            guard remaining.isEmpty else { throw AgentBridgeError.server("未能移除每日委托的待发提醒") }
            return ["cancelledCount":pending.count]
        }
    }

    static func knownTopic(_ request: UNNotificationRequest, scope: DailyReminderScope) -> String? {
        if let topic = scope.topic(of: request) { return topic }
        return topics.first { ledger()[scope.identifier($0)]?["identifier"] == request.identifier &&
            request.content.userInfo["goalKey"] as? String == scope.goalKey &&
            request.trigger is UNCalendarNotificationTrigger && !request.trigger!.repeats }
    }

    static func coveredAdoptedID(_ id: String, goalKey: String, date: Date, pending: [UNNotificationRequest]) -> String? {
        for row in ledger().values where row["goalKey"] == goalKey && row["planTaskId"] == id &&
             DailyReminderScope.date(row["scheduledFor"]) == date {
            if let identifier = row["identifier"], let r = pending.first(where: { $0.identifier == identifier }),
               r.content.userInfo["goalKey"] as? String == goalKey,
               let trigger = r.trigger as? UNCalendarNotificationTrigger, !trigger.repeats, trigger.nextTriggerDate() == date {
                return identifier
            }
        }
        return nil
    }

    static func deliveryTopic(_ request: UNNotificationRequest, goalKey: String) -> String? {
        if owns(request, goalKey: goalKey) { return request.content.userInfo["dailyTopic"] as? String }
        return ledger().values.first { $0["identifier"] == request.identifier && $0["goalKey"] == goalKey }?["topic"]
    }

    static func preservesIndependentRequest(_ request: UNNotificationRequest) -> Bool {
        if ledger().values.contains(where: { $0["identifier"] == request.identifier }) { return true }
        // Before the first daily sync, a user may adopt the new DSH workout layout.
        // Preserve the previous one-off sleep preparation identified by its own dated plan ID.
        guard let key = request.content.userInfo["goalKey"] as? String,
              let trigger = request.trigger as? UNCalendarNotificationTrigger, !trigger.repeats, let date = trigger.nextTriggerDate(),
              let scope = try? DailyReminderScope(["goalKey":key,"localDate":DailyReminderScope.day(date,in:.current),"timezone":TimeZone.current.identifier],now:date)
        else { return false }
        return scope.topic(of:request) == "sleep"
    }

    private static func applied(_ scope: DailyReminderScope) -> [String:String]? {
        let saved = (UserDefaults.standard.dictionary(forKey: appliedKey) as? [String:[String:String]])?[scope.identifier("decision")]
        guard let entry = saved, let grant = entry["delegationId"],
              (UserDefaults.standard.dictionary(forKey: mandateKey) as? [String:String])?[scope.goalKey] == grant else { return nil }
        return entry
    }

    private static func row(_ r: UNNotificationRequest, _ state: String, date: Date) -> [String: Any] {
        var result: [String: Any] = ["status": state, "title": r.content.title,
            "requestId": r.content.userInfo["requestId"] as? String ?? "", "taskId": r.content.userInfo["taskId"] as? String ?? ""]
        let key = state == "delivered" ? "deliveredAt" : "scheduledFor"
        result[key] = ISO8601DateFormatter().string(from: date)
        if state == "delivered" {
            if let planned = (r.trigger as? UNCalendarNotificationTrigger)?.dateComponents.date {
                result["scheduledFor"] = ISO8601DateFormatter().string(from: planned)
            } else if let planned = ledger().values.first(where: { $0["identifier"] == r.identifier })?["scheduledFor"] {
                result["scheduledFor"] = planned
            }
        }
        if let ticket = r.content.userInfo["ticketId"] as? String { result["ticketId"] = ticket }
        return result
    }

    static func status(_ scope: DailyReminderScope) async -> [String: Any] {
        let pending = await center.pendingNotificationRequests()
        let delivered = await center.deliveredNotifications()
        var items: [String: [String: Any]] = [:]
        for topic in topics {
            if let found = delivered.filter({ knownTopic($0.request, scope: scope) == topic }).max(by: { $0.date < $1.date }) {
                items[topic] = row(found.request, "delivered", date: found.date)
            } else if let r = pending.first(where: { knownTopic($0, scope: scope) == topic }),
                      let date = (r.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate() {
                items[topic] = row(r, "scheduled", date: date)
            } else if let recorded = ledger()[scope.identifier(topic)] {
                items[topic] = ["status":"unconfirmed","scheduledFor":recorded["scheduledFor"] ?? "", "requestId":recorded["requestId"] ?? ""]
            } else { items[topic] = ["status":"none"] }
        }
        var value: [String:Any] = ["goalKey":scope.goalKey, "localDate":scope.localDate, "timezone":scope.zone.identifier,"items":items]
        if let entry = applied(scope) {
            value["delegationId"] = entry["delegationId"]
            value["appliedRequestId"] = entry["requestId"]
            value["ticketId"] = entry["ticketId"]
        }
        return value
    }

    static func apply(_ value: [String: Any]) async throws -> [String: Any] {
        return try await enqueue(value, verifiedRun: nil, fromBackground: false)
    }

    private static func enqueue(_ value: [String: Any], verifiedRun: [String: Any]?, fromBackground: Bool) async throws -> [String: Any] {
        let key = value["goalKey"] as? String ?? ""
        let generation = generations[key, default:0]
        return try await serialized { try await applyBatch(value, generation: generation, verifiedRun: verifiedRun, fromBackground: fromBackground) }
    }

    // The regular accepted layout and a daily delegation can refer to the same task.
    // Serialize both native mutation entry points so that each sees the other's readback.
    static func serialized(_ operation: @escaping @MainActor () async throws -> [String: Any]) async throws -> [String: Any] {
        let previous = tail
        let work = Task {
            await previous?.value
            return try await operation()
        }
        tail = Task { _ = try? await work.value }
        return try await work.value
    }

    private static func applyBatch(_ value: [String: Any], generation: Int, verifiedRun: [String: Any]?, fromBackground: Bool) async throws -> [String: Any] {
        let scope = try DailyReminderScope(value)
        guard value["delegated"] as? Bool == true, let scopeTypes = value["selectedTypes"] as? [String],
              let rid = value["requestId"] as? String, !rid.isEmpty, rid.count <= 160,
              let ticket = value["ticketId"] as? String, !ticket.isEmpty, ticket.count <= 160,
              let connection = AlongConnectionStore.load() else { throw AgentBridgeError.server("当前目标没有可核验的 DSH 每日委托") }
        var input = connection.reduce(into: [String: Any]()) { $0[$1.key] = $1.value }
        input["path"] = "/super-agent/goals/status"
        input["body"] = ["runtime":"dsh-superagent","requestId":rid,"contextReview":true] as [String: Any]
        let response: [String: Any]
        if let verifiedRun { response = verifiedRun }
        else { response = try await AlongWebView.Coordinator.agentRequest(input) }
        let (actions, permitted, mandate) = try scope.verifiedActions(response, requestID: rid, ticketID: ticket)
        let defaults = UserDefaults.standard
        guard generations[scope.goalKey, default:0] == generation,
              (defaults.dictionary(forKey: revokedKey) as? [String:String])?[scope.goalKey] != mandate else { throw AgentBridgeError.server("该目标的每日委托已撤销") }
        let selected = Set(defaults.stringArray(forKey:"along.health.selectedTypes") ?? [])
        guard defaults.bool(forKey:"along.health.contextReview.v1"), !permitted.isEmpty,
              permitted.isSubset(of:Set(scopeTypes)), permitted.isSubset(of:selected) else { throw AgentBridgeError.server("每日委托的健康范围已更改") }
        let run = response["run"] as? [String:Any] ?? response
        let planning = ((run["input"] as? [String:Any])?["snapshot"] as? [String:Any])?["planning"] as? [String:Any]
        guard let planTime = planning?["now"] as? String, let evaluated = DailyReminderScope.date(planTime) else { throw AgentBridgeError.invalidConfiguration }
        if let entry = applied(scope), let newer = DailyReminderScope.date(entry["planningAt"]), newer > evaluated { return await status(scope) }
        var active = defaults.dictionary(forKey: mandateKey) as? [String:String] ?? [:]
        if fromBackground && active[scope.goalKey] != mandate { throw AgentBridgeError.server("每日委托已失效") }
        if active[scope.goalKey] != mandate {
            active[scope.goalKey] = mandate
            defaults.set(active, forKey: mandateKey)
            BackgroundHealthReviews.shared.dailyGrantChanged()
        }
        let auth = await center.notificationSettings().authorizationStatus
        guard [.authorized,.provisional,.ephemeral].contains(auth) else { throw AgentBridgeError.server("Along 尚未获准发送系统通知") }
        let types = Set(scopeTypes).intersection(permitted)
        let minutes = actions["workoutMinutes"] as? Int
        guard let minutes, (0...1440).contains(minutes) else { throw AgentBridgeError.server("DSH 尚未给出有效的今日运动时长") }
        for topic in topics where types.contains(topic) {
            guard !fromBackground || (defaults.string(forKey: BackgroundHealthReviews.goalPreference) == scope.goalKey && defaults.bool(forKey: "along.health.backgroundReviewArmed.v1")),
                  generations[scope.goalKey, default:0] == generation, UserDefaults.standard.bool(forKey: "along.health.contextReview.v1"),
                  (UserDefaults.standard.stringArray(forKey: "along.health.selectedTypes") ?? []).contains(topic),
                  AlongConnectionStore.load() == connection, DailyReminderScope.day(Date(), in: scope.zone) == scope.localDate else {
                throw AgentBridgeError.server("健康授权或连接已更改，请刷新当前目标")
            }
            let raw = actions[topic == "sleep" ? "sleepReminderAt" : "workoutReminderAt"] as? String
            let key = scope.identifier(topic)
            guard let raw else {
                if actions[topic == "sleep" ? "sleepReminderAt" : "workoutReminderAt"] is NSNull {
                    // Only our own future notification is canceled. Manual and legacy reminders have other identifiers.
                    let mine = await center.pendingNotificationRequests().filter { $0.identifier == key }
                    if !mine.isEmpty { center.removePendingNotificationRequests(withIdentifiers: [key]) }
                }
                continue
            }
            guard let date = DailyReminderScope.date(raw), DailyReminderScope.day(date, in: scope.zone) == scope.localDate,
                  topic != "workout" || minutes > 0 else { throw AgentBridgeError.server("DSH 每日提醒时间与行动不一致") }
            guard date > Date() else { continue }
            let run = response["run"] as? [String:Any] ?? response
            let layout = (run["result"] as? [String:Any])?["layout"] as? [String:Any]
            let otherTime = DailyReminderScope.date(actions[topic == "sleep" ? "workoutReminderAt" : "sleepReminderAt"] as? String)
            let layoutMatches = (layout?["tasks"] as? [[String:Any]] ?? []).filter {
                $0["kind"] as? String == "reminder" && DailyReminderScope.date($0["scheduledFor"] as? String) == date
            }
            let planTaskID = otherTime != date && layoutMatches.count == 1 ? layoutMatches[0]["id"] as? String : nil
            func isThisItem(_ req: UNNotificationRequest) -> Bool {
                if knownTopic(req, scope: scope) == topic { return true }
                guard let planTaskID, let trigger = req.trigger as? UNCalendarNotificationTrigger, !trigger.repeats,
                      req.content.userInfo["goalKey"] as? String == scope.goalKey, req.content.userInfo["taskId"] as? String == planTaskID,
                      let rid = req.content.userInfo["requestId"] as? String, !rid.isEmpty else { return false }
                let prefix = scope.goalKey == "health" ? "along.health-plan." : "along.custom-health-plan."+DailyReminderScope.hash(scope.goalKey)+"."
                return req.identifier == prefix + DailyReminderScope.hash(planTaskID) && trigger.dateComponents.date == date
            }
            let already = await center.deliveredNotifications().contains { isThisItem($0.request) }
            if already { continue }
            let existing = await center.pendingNotificationRequests().first { isThisItem($0) }
            if let existing, let next = (existing.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate(),
               existing.identifier != key || next == date {
                // Keep a previously arranged sleep reminder, including the existing one-off task.
                remember(existing, scope: scope, topic: topic, date: next, planTaskID: planTaskID)
                continue
            }
            // If the OS has removed a notification after its intended time, its presentation
            // cannot be reconstructed. Do not send the same day's topic a second time.
            if existing == nil, let last = DailyReminderScope.date(ledger()[key]?["scheduledFor"]), last <= Date() { continue }
            let c = UNMutableNotificationContent()
            c.title = topic == "sleep" ? "睡前准备提醒" : "今日运动提醒"
            if topic == "workout" { c.body = "今天还安排了 \(minutes) 分钟运动，按自己的节奏开始。" }
            else if let bed = DailyReminderScope.date(actions["bedtimeAt"] as? String) {
                let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.timeZone = scope.zone; f.dateFormat = "HH:mm"
                c.body = "开始睡前准备。今天建议在 \(f.string(from: bed)) 上床。"
            } else { c.body = "可以开始今晚的睡前准备了。" }
            c.body = String(c.body.prefix(180))
            c.sound = .default
            c.threadIdentifier = "along.agent.action"
            c.userInfo = ["kind":"task","goalKey":scope.goalKey,"taskId":"daily-\(topic)-\(scope.localDate)","requestId":rid,
                          "ticketId":ticket,"dailyTopic":topic,"localDate":scope.localDate]
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = scope.zone
            let components = calendar.dateComponents([.calendar,.timeZone,.year,.month,.day,.hour,.minute,.second], from: date)
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            let request = UNNotificationRequest(identifier: key, content: c, trigger: trigger)
            guard !fromBackground || (defaults.string(forKey: BackgroundHealthReviews.goalPreference) == scope.goalKey && defaults.bool(forKey: "along.health.backgroundReviewArmed.v1")),
                  generations[scope.goalKey, default:0] == generation, AlongConnectionStore.load() == connection,
                  defaults.bool(forKey: "along.health.contextReview.v1"),
                  (defaults.stringArray(forKey: "along.health.selectedTypes") ?? []).contains(topic) else {
                throw AgentBridgeError.server("健康授权或每日委托已更改")
            }
            try await center.add(request)
            let saved = await center.pendingNotificationRequests().filter { $0.identifier == key }
            guard saved.count == 1, let item = saved.first, scope.topic(of: item) == topic,
                  let timer = item.trigger as? UNCalendarNotificationTrigger, !timer.repeats, timer.nextTriggerDate() == date,
                  item.content.userInfo["requestId"] as? String == rid else {
                throw AgentBridgeError.server("未取得这个提醒的 iOS 预约回执")
            }
            remember(item, scope: scope, topic: topic, date: date, planTaskID: planTaskID)
        }
        guard generations[scope.goalKey, default:0] == generation,
              permitted.isSubset(of:Set(defaults.stringArray(forKey:"along.health.selectedTypes") ?? [])),
              defaults.bool(forKey:"along.health.contextReview.v1") else { throw AgentBridgeError.server("健康范围或每日委托已更改") }
        var confirmed = (defaults.dictionary(forKey:appliedKey) as? [String:[String:String]] ?? [:]).filter {
            guard let at = DailyReminderScope.date($0.value["planningAt"]) else { return false }
            return at > Date().addingTimeInterval(-3 * 86400)
        }
        confirmed[scope.identifier("decision")] = ["delegationId":mandate,"requestId":rid,"ticketId":ticket,"planningAt":planTime]
        defaults.set(confirmed, forKey:appliedKey)
        let readBack = await status(scope)
        recordReadback(readBack, scope: scope, requestID: rid, ticket: ticket)
        return readBack
    }

    // This route can only be reached with a response from the native pinned Host connection.
    // A foreground daily commission and the separate background goal grant must still match.
    static func permitsBackground(_ grant: [String: Any], goalKey: String, selectedTypes: [String]) -> Bool {
        let d = UserDefaults.standard
        guard let id = grant["id"] as? String, !id.isEmpty, grant["goalKey"] as? String == goalKey,
              let topics = grant["topics"] as? [String], d.bool(forKey: "along.health.contextReview.v1"),
              (d.dictionary(forKey: mandateKey) as? [String:String])?[goalKey] == id,
              (d.dictionary(forKey: revokedKey) as? [String:String])?[goalKey] != id else { return false }
        let requested = Set(topics)
        return !requested.isEmpty && requested.isSubset(of:["sleep","workout"]) && requested.isSubset(of:Set(selectedTypes)) &&
            requested.isSubset(of:Set(d.stringArray(forKey:"along.health.selectedTypes") ?? []))
    }

    static func receivedInBackground(_ run: [String: Any], goalKey: String, selectedTypes: [String]) async -> Bool {
        guard let requestID = run["requestId"] as? String, let ticket = (run["ticket"] as? [String:Any])?["id"] as? String,
              let snapshot = (run["input"] as? [String:Any])?["snapshot"] as? [String:Any],
              let planning = snapshot["planning"] as? [String:Any], let delegation = planning["dailyDelegation"] as? [String:Any],
              delegation["goalKey"] as? String == goalKey, let mandate = delegation["id"] as? String,
              let active = UserDefaults.standard.dictionary(forKey: mandateKey) as? [String:String], active[goalKey] == mandate,
              UserDefaults.standard.string(forKey: BackgroundHealthReviews.goalPreference) == goalKey,
              let day = planning["localDate"] as? String, let zone = planning["timezone"] as? String else { return false }
        let value: [String:Any] = ["goalKey":goalKey,"requestId":requestID,"ticketId":ticket,"localDate":day,
                                 "timezone":zone,"selectedTypes":selectedTypes,"delegated":true]
        return (try? await enqueue(value, verifiedRun: run, fromBackground: true)) != nil
    }

    private static func recordReadback(_ status: [String:Any], scope: DailyReminderScope, requestID: String, ticket: String) {
        guard let rows = status["items"] as? [String:[String:Any]],
              let cache = FileManager.default.urls(for:.cachesDirectory, in:.userDomainMask).first else { return }
        let dir = cache.appendingPathComponent("AlongDailyReminders", isDirectory: true)
        let file = dir.appendingPathComponent(DailyReminderScope.hash(scope.goalKey+"|"+scope.localDate)+".json")
        let safe = rows.mapValues { row in row.filter { ["status","scheduledFor","deliveredAt","requestId","ticketId"].contains($0.key) } }
        let receipt: [String:Any] = ["goalKey":scope.goalKey,"localDate":scope.localDate,"timezone":scope.zone.identifier,
                  "ticketId":ticket,"requestId":requestID,"items":safe,"checkedAt":ISO8601DateFormatter().string(from: Date())]
        do {
            try FileManager.default.createDirectory(at:dir, withIntermediateDirectories:true, attributes:[.protectionKey:FileProtectionType.complete])
            try JSONSerialization.data(withJSONObject:receipt).write(to:file,options:[.atomic,.completeFileProtection])
        } catch { /* iOS owns the notification; a cache write failure does not cancel it. */ }
    }
}
