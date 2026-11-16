import Foundation
import UIKit
import UserNotifications

@MainActor final class EventTaskNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = EventTaskNotifications()
    private let center = UNUserNotificationCenter.current()
    private let defaults = UserDefaults.standard
    private let prefix = "along.event."
    private let routeKey = "along.event.notification.route"
    private let scopeKey = "along.event.notification.scope"
    private let sinceKey = "along.event.notification.since"
    private let receiptsKey = "along.event.notification.results"
    private var checkedScope: String?
    private var deviceToken: String?
    private var registered: String?
    private var registrationExpires = Date.distantPast
    private var registering = false
    private var retryRegistration = Date.distantPast
    private var cursor = -1
    private var sentPlan: Data?
    private var planExpires = Date.distantPast
    private var nextPlan: (connection: [String:String], body: [String:Any])?
    private var sendingPlan = false
    weak var coordinator: AlongWebView.Coordinator?
    private let legacyKey = "along.notification.legacy-open.v1"
    var legacyOpen: [String:String]? { defaults.dictionary(forKey:legacyKey) as? [String:String] }
    func ackLegacy(_ id: String) { if legacyOpen?["legacyOpenId"] == id {defaults.removeObject(forKey:legacyKey)} }
    func receiveLegacy(_ request: UNNotificationRequest) {
        guard let route=AlongWebView.Coordinator.legacyPayload(request) else {return}
        defaults.removeObject(forKey:routeKey)
        defaults.set(route,forKey:legacyKey)
        coordinator?.openNotification(route)
    }

    private func valid(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.range(of: #"^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$"#, options: .regularExpression) != nil
    }

    private func verified(_ connection: [String:String], user: String) async throws -> String {
        let scope = DailyReminderScope.hash([connection["fingerprint"] ?? "", connection["token"] ?? "", user].joined(separator: "\n"))
        if checkedScope == scope { return scope }
        var input: [String:Any] = connection
        input["path"] = "/connection/status"; input["body"] = ["runtime":"dsh-superagent"]
        let response = try await AlongWebView.Coordinator.agentRequest(input)
        guard response["ready"] as? Bool == true, response["eventProtocol"] as? Int == 1,
              response["userId"] as? String == user, AlongConnectionStore.load() == connection else {
            throw AgentBridgeError.invalidConfiguration
        }
        checkedScope = scope; cursor = -1; sentPlan = nil; planExpires = .distantPast
        if defaults.string(forKey: scopeKey) != scope {
            defaults.set(scope, forKey: scopeKey); defaults.removeObject(forKey: sinceKey)
            defaults.removeObject(forKey: receiptsKey)
            if pendingRoute?["userId"] as? String != user { defaults.removeObject(forKey: routeKey) }
        }
        return scope
    }

    private var environment: String? {
        let value = Bundle.main.object(forInfoDictionaryKey: "AlongAPNsEnvironment") as? String
        return value == "development" || value == "production" ? value : nil
    }

    func received(token data: Data) {
        deviceToken = data.map { String(format:"%02x",$0) }.joined()
        retryRegistration = .distantPast
        Task { await refreshRegistration() }
    }

    private var deviceUser: String?
    private var registrationAllowed = false
    private func refreshRegistration() async {
        guard !registering, Date() >= retryRegistration, let user = deviceUser, let scope = checkedScope,
              let connection = AlongConnectionStore.load(),
              scope == DailyReminderScope.hash([connection["fingerprint"] ?? "",connection["token"] ?? "",user].joined(separator:"\n")) else { return }
        let desired = scope + (registrationAllowed ? (deviceToken ?? "") : "off")
        guard registered != desired || Date() >= registrationExpires else { return }
        var body: [String:Any] = ["expectedUserId":user]
        if registrationAllowed {
            guard let environment else { return }
            guard let deviceToken else {
                retryRegistration = Date().addingTimeInterval(30)
                UIApplication.shared.registerForRemoteNotifications()
                return
            }
            body["token"] = deviceToken; body["environment"] = environment
        } else { body["enabled"] = false }
        registering = true
        defer { registering = false }
        do {
            var input: [String:Any] = connection
            input["path"] = "/notifications/device"; input["body"] = body
            let response = try await AlongWebView.Coordinator.agentRequest(input, background: true, privateNotificationRequest: true)
            guard response["userId"] as? String == user, AlongConnectionStore.load() == connection,
                  scope == checkedScope else { return }
            if registrationAllowed && response["remoteNotifications"] as? Bool != true {
                retryRegistration = Date().addingTimeInterval(60)
                return
            }
            registered = desired
            registrationExpires = Date().addingTimeInterval(1800)
        } catch { retryRegistration = Date().addingTimeInterval(30) }
    }

    private func captureOwnership(_ user: String, allowed: Bool) {
        if deviceUser != user || registrationAllowed != allowed {
            registered = nil; retryRegistration = .distantPast
        }
        deviceUser = user; registrationAllowed = allowed
        Task { await refreshRegistration() }
    }

    private func requestID(scope: String, goal: String, task: String) -> String {
        prefix + "task." + DailyReminderScope.hash([scope,goal,task].joined(separator:"\n"))
    }

    func synchronize(_ value: [String:Any]) async throws -> [String:Any] {
        try await DailyHealthReminders.serialized { try await self.reconcile(value) }
    }

    static func reminderTiming(date: Date, rule: String?, timezone: String?, weekday: Int?, wallTime: Date?, now: Date) -> (parts: DateComponents, repeats: Bool)? {
        var calendar = Calendar(identifier:.gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT:0)!
        let once = calendar.dateComponents([.calendar,.timeZone,.year,.month,.day,.hour,.minute,.second],from:date)
        guard let rule else { return (once,false) }
        guard ["daily","weekly"].contains(rule), let timezone, let zone=TimeZone(identifier:timezone),
              rule == "weekly" ? (weekday.map { (1...7).contains($0) } ?? false) : weekday == nil else { return nil }
        calendar.timeZone = zone
        if let weekday, calendar.component(.weekday,from:date) != weekday % 7 + 1 { return nil }
        var parts = calendar.dateComponents([.calendar,.timeZone,.hour,.minute,.second],from:wallTime ?? date)
        if let weekday { parts.weekday = weekday % 7 + 1 }
        guard let next=calendar.nextDate(after:now,matching:parts,matchingPolicy:.nextTimePreservingSmallerComponents,
                                        repeatedTimePolicy:.first) else { return nil }
        // Calendar repeats have no start date. Keep an intentionally later first occurrence as
        // a dated request until the app next synchronizes, rather than notifying too early.
        if date > now && abs(next.timeIntervalSince(date)) > 1 { return (once,false) }
        return (parts,true)
    }

    private func reconcile(_ value: [String:Any]) async throws -> [String:Any] {
        guard let c = AlongConnectionStore.load(), let user = value["userId"] as? String, valid(user),
              let pin = value["fingerprint"] as? String, pin.uppercased() == c["fingerprint"],
              let version = value["cursor"] as? Int, version >= 0,
              let rows = value["reminders"] as? [[String:Any]], let activeTasks = value["activeTasks"] as? [[String:Any]], let results = value["results"] as? [[String:Any]] else {
            throw AgentBridgeError.invalidConfiguration
        }
        let scope = try await verified(c,user:user)
        let permission = await center.notificationSettings().authorizationStatus
        let allowed = [.authorized,.ephemeral,.provisional].contains(permission)
        captureOwnership(user,allowed:allowed && environment != nil)
        guard AlongConnectionStore.load() == c, version >= cursor else { throw AgentBridgeError.invalidConfiguration }
        let pending = await center.pendingNotificationRequests()
        let delivered = await center.deliveredNotifications()
        recordProbe(pending:pending, delivered:delivered, permission:permission)
        var activeRevisions: [String:Int] = [:]
        for row in activeTasks {
            guard let goal=row["goalId"] as? String,valid(goal),let task=row["taskId"] as? String,valid(task),
                  let revision=row["revision"] as? Int else { throw AgentBridgeError.invalidConfiguration }
            activeRevisions[goal+":"+task] = revision
        }
        let withdrawn = delivered.filter { note in
            guard let route=note.request.content.userInfo["along"] as? [String:Any] else { return false }
            return Self.withdrawn(route,user:user,allowed:allowed,openTasks:activeRevisions)
        }
        if !withdrawn.isEmpty { center.removeDeliveredNotifications(withIdentifiers:withdrawn.map { $0.request.identifier }) }
        let existing = Dictionary(uniqueKeysWithValues:pending.map { ($0.identifier,$0) })
        var desired: [(Date,UNNotificationRequest)] = []
        let now = Date()
        if allowed {
            if defaults.object(forKey: sinceKey) == nil { defaults.set(now, forKey: sinceKey) }
            for row in rows {
                guard let goal = row["goalId"] as? String, valid(goal), let task = row["taskId"] as? String, valid(task),
                      let revision = row["revision"] as? Int, revision >= 0, let body = row["body"] as? String,
                      !body.isEmpty, body.utf16.count <= 120, let date = DailyReminderScope.date(row["scheduledAt"] as? String) else {
                    throw AgentBridgeError.invalidConfiguration
                }
                guard (row["repeat"] == nil || row["repeat"] is String),
                      (row["timezone"] == nil || row["timezone"] is String),
                      (row["weekday"] == nil || row["weekday"] is Int),
                      (row["wallTime"] == nil || DailyReminderScope.date(row["wallTime"] as? String) != nil),
                      let timing = Self.reminderTiming(date:date,rule:row["repeat"] as? String,timezone:row["timezone"] as? String,
                        weekday:row["weekday"] as? Int,wallTime:DailyReminderScope.date(row["wallTime"] as? String),now:now) else {
                    throw AgentBridgeError.invalidConfiguration
                }
                guard date > now || timing.repeats else { continue }
                let identifier = requestID(scope:scope,goal:goal,task:task)
                let content = UNMutableNotificationContent()
                content.title = "Along 任务提醒"; content.body = body; content.sound = .default
                content.userInfo = ["along":["kind":"reminder","userId":user,"goalId":goal,"taskId":task,
                    "eventId":DailyReminderScope.hash(identifier+"|"+String(revision)), "revision":revision] as [String:Any]]
                let trigger = UNCalendarNotificationTrigger(dateMatching:timing.parts,repeats:timing.repeats)
                // The system decides the actual next civil occurrence, including DST behavior.
                // A system recurrence disagreeing with the Agent's first deadline stays one-time.
                let actual: UNCalendarNotificationTrigger
                if timing.repeats, date > now, let next=trigger.nextTriggerDate(), abs(next.timeIntervalSince(date)) > 1,
                   let once=Self.reminderTiming(date:date,rule:nil,timezone:nil,weekday:nil,wallTime:nil,now:now) {
                    actual = UNCalendarNotificationTrigger(dateMatching:once.parts,repeats:false)
                } else { actual = trigger }
                guard let next=actual.nextTriggerDate() else { throw AgentBridgeError.invalidConfiguration }
                desired.append((next,UNNotificationRequest(identifier:identifier,content:content,trigger:actual)))
            }
        } else { defaults.removeObject(forKey: sinceKey) }
        // Keep slots already occupied by other app features. iOS retains at most 64 pending requests per app.
        let otherCount = pending.filter { !$0.identifier.hasPrefix(prefix+"task.") }.count
        let planned = desired.sorted { ($0.0,$0.1.identifier) < ($1.0,$1.1.identifier) }.prefix(max(0,64-otherCount)).map(\.1)
        let ids = Set(planned.map(\.identifier))
        let obsolete = pending.filter { $0.identifier.hasPrefix(prefix+"task.") && !ids.contains($0.identifier) ||
            !allowed && $0.identifier.hasPrefix(prefix+"result.") }
        guard AlongConnectionStore.load() == c else { throw AgentBridgeError.invalidConfiguration }
        if !obsolete.isEmpty { center.removePendingNotificationRequests(withIdentifiers:obsolete.map(\.identifier)) }
        for item in planned {
            guard AlongConnectionStore.load() == c else { throw AgentBridgeError.invalidConfiguration }
            if let old = existing[item.identifier], sameRequest(old,item) { continue }
            try await center.add(item)
        }
        if allowed { try await postResults(results,user:user,scope:scope,connection:c,delivered:delivered) }
        let readback = await center.pendingNotificationRequests()
        recordProbe(pending:readback, delivered:await center.deliveredNotifications(), permission:permission)
        let returned = Set(readback.map(\.identifier))
        let confirmed = Dictionary(uniqueKeysWithValues:readback.map { ($0.identifier,$0) })
        guard planned.allSatisfy({ r in confirmed[r.identifier].map { sameRequest($0,r) } == true ||
            ((r.trigger as? UNCalendarNotificationTrigger)?.dateComponents.date ?? .distantFuture) <= Date() }),
              returned.isDisjoint(with:obsolete.map(\.identifier)) else { throw AgentBridgeError.server("系统提醒预约尚未完成") }
        // The Host can cover deadlines not already scheduled on this phone (for example tomorrow's renewal).
        // A missing or offline Host never invalidates an iOS receipt.
        let inventory = rows.compactMap { row -> [String:Any]? in
            guard let goal=row["goalId"] as? String, let task=row["taskId"] as? String,
                  ids.contains(requestID(scope:scope,goal:goal,task:task)),
                  let request=confirmed[requestID(scope:scope,goal:goal,task:task)],
                  let trigger=request.trigger as? UNCalendarNotificationTrigger, let next=trigger.nextTriggerDate() else { return nil }
            var receipt=row.filter { ["goalId","taskId","revision"].contains($0.key) }
            receipt["scheduledAt"]=ISO8601DateFormatter().string(from:next)
            if trigger.repeats {
                receipt["repeat"]=row["repeat"]; receipt["timezone"]=trigger.dateComponents.timeZone?.identifier
                receipt["weekday"]=row["weekday"]; receipt["firstScheduledAt"]=row["scheduledAt"]
                receipt["wallTime"]=row["wallTime"]
            }
            return receipt
        }
        queuePlanReport(connection:c,user:user,inventory:inventory)
        cursor = version
        var result: [String:Any] = ["scheduledCount":ids.count,"deferredCount":desired.count-ids.count]
        if let route = pendingRoute, route["userId"] as? String == user { result["route"] = route }
        return result
    }

    private func queuePlanReport(connection: [String:String], user: String, inventory: [[String:Any]]) {
        nextPlan = (connection,["expectedUserId":user,"reminders":inventory])
        guard !sendingPlan else { return }
        sendingPlan = true
        Task {
            defer { sendingPlan=false }
            while let item=nextPlan {
                nextPlan=nil
                guard AlongConnectionStore.load() == item.connection,
                      let digest=try? JSONSerialization.data(withJSONObject:item.body,options:.sortedKeys) else { continue }
                if sentPlan==digest && Date()<planExpires { continue }
                var input: [String:Any]=item.connection
                input["path"]="/notifications/scheduled";input["body"]=item.body
                if (try? await AlongWebView.Coordinator.agentRequest(input,background:true,privateNotificationRequest:true)) != nil,
                   AlongConnectionStore.load() == item.connection {
                    sentPlan=digest;planExpires=Date().addingTimeInterval(300)
                }
            }
        }
    }

    static func withdrawn(_ route: [String:Any], user: String, allowed: Bool, openTasks: [String:Int]) -> Bool {
        if !allowed || route["userId"] as? String != user { return true }
        guard let kind=route["kind"] as? String, ["reminder","reminder_due"].contains(kind) else { return false }
        guard let goal=route["goalId"] as? String, let task=route["taskId"] as? String,
              let revision=route["revision"] as? Int else { return true }
        return openTasks[goal+":"+task] != revision
    }

    private func sameRequest(_ a: UNNotificationRequest, _ b: UNNotificationRequest) -> Bool {
        guard let x=a.trigger as? UNCalendarNotificationTrigger, let y=b.trigger as? UNCalendarNotificationTrigger,
              x.repeats == y.repeats else { return false }
        return x.dateComponents == y.dateComponents && a.content.body == b.content.body &&
            (a.content.userInfo["along"] as? NSDictionary) == (b.content.userInfo["along"] as? NSDictionary)
    }

    private func postResults(_ rows: [[String:Any]], user: String, scope: String, connection: [String:String],
                             delivered: [UNNotification]) async throws {
        guard let since = defaults.object(forKey: sinceKey) as? Date else { return }
        var receipts = (defaults.dictionary(forKey: receiptsKey) as? [String:Date] ?? [:]).filter { Date().timeIntervalSince($0.value)<86400 }
        for row in rows {
            guard let event = row["eventId"] as? String, event.range(of:#"^[A-Za-z0-9_.:-]{1,200}$"#,options:.regularExpression) != nil,
                  let kind = row["kind"] as? String, ["recommendation_ready","task_result"].contains(kind),
                  let date = DailyReminderScope.date(row["createdAt"] as? String), date >= since, Date().timeIntervalSince(date) <= 600,
                  let goal = row["goalId"] as? String, valid(goal), let revision = row["revision"] as? Int, revision>=0,
                  row["taskId"] == nil || valid(row["taskId"] as? String) else { continue }
            let key = prefix+"result."+DailyReminderScope.hash(scope+"\n"+event)
            if receipts[key] != nil || delivered.contains(where:{ $0.request.identifier == key }) { continue }
            let content = UNMutableNotificationContent()
            content.title = kind == "recommendation_ready" ? "Along 推荐已就绪" : "Along 任务有了结果"
            content.body = "点开查看你的目标。"; content.sound = .default
            var payload = row.filter { ["eventId","kind","goalId","taskId","revision"].contains($0.key) }
            payload["userId"] = user; content.userInfo = ["along":payload]
            guard AlongConnectionStore.load() == connection else { throw AgentBridgeError.invalidConfiguration }
            try await center.add(UNNotificationRequest(identifier:key,content:content,trigger:nil))
            receipts[key] = Date(); defaults.set(receipts,forKey:receiptsKey)
        }
    }

    private var pendingRoute: [String:Any]? { defaults.dictionary(forKey:routeKey) }

    func opened(_ value: [String:Any]) {
        guard let route = pendingRoute, let event = value["eventId"] as? String, route["eventId"] as? String == event,
              route["goalId"] as? String == value["goalId"] as? String, route["userId"] as? String == value["userId"] as? String else { return }
        if let task = route["taskId"] as? String, task == value["taskId"] as? String { updateProbe(task,["openedAt":ISO8601DateFormatter().string(from:Date())]) }
        defaults.removeObject(forKey:routeKey)
    }

    func attach(_ coordinator: AlongWebView.Coordinator) {
        self.coordinator = coordinator
        if let route=legacyOpen {coordinator.openNotification(route)}
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler handler: @escaping (UNNotificationPresentationOptions)->Void) {
        handler([.banner,.list,.sound])
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler handler: @escaping ()->Void) {
        Task { @MainActor in self.handle(response, completion:handler) }
    }

    private func handle(_ response: UNNotificationResponse, completion handler: @escaping ()->Void) {
        if let route = response.notification.request.content.userInfo["along"] as? [String:Any] {
            guard valid(route["userId"] as? String), valid(route["goalId"] as? String), let event = route["eventId"] as? String,
                  !event.isEmpty, event.count <= 200, let kind = route["kind"] as? String,
                  ["reminder","reminder_due","recommendation_ready","task_result"].contains(kind),
                  route["taskId"] == nil || valid(route["taskId"] as? String) else { handler(); return }
            let clean = route.compactMapValues { $0 as? String }.filter { ["userId","goalId","taskId","eventId","kind"].contains($0.key) }
            defaults.removeObject(forKey:legacyKey)
            defaults.set(clean,forKey:routeKey)
            if let task = clean["taskId"] { updateProbe(task,["deliveredAt":ISO8601DateFormatter().string(from:response.notification.date),
                                                              "tappedAt":ISO8601DateFormatter().string(from:Date())]) }
            coordinator?.openNotification(clean)
            handler()
        } else { receiveLegacy(response.notification.request);handler() }
    }

    private func updateProbe(_ task: String, _ values: [String:String]) {
#if DEBUG
        guard valid(task), let cache = FileManager.default.urls(for:.cachesDirectory,in:.userDomainMask).first else { return }
        let url = cache.appendingPathComponent("AlongNotificationProbe.json")
        var state = (try? Data(contentsOf:url)).flatMap { try? JSONSerialization.jsonObject(with:$0) as? [String:String] } ?? [:]
        let marker = DailyReminderScope.hash(task)
        if let probe = ProcessInfo.processInfo.environment["ALONG_NOTIFICATION_PROBE_TASK"] {
            guard probe == task else { return }
            if state["probe"] != marker { state = ["probe":marker] }
            state["probeExpiresAt"] = ISO8601DateFormatter().string(from:Date().addingTimeInterval(1800))
        } else {
            // A cold notification tap may relaunch without the debug environment.
            guard state["probe"] == marker, let until=DailyReminderScope.date(state["probeExpiresAt"]), Date()<until else { return }
        }
        state.merge(values) { _,new in new }
        try? JSONSerialization.data(withJSONObject:state).write(to:url,options:[.atomic,.completeFileProtection])
#endif
    }
    private func recordProbe(pending: [UNNotificationRequest], delivered: [UNNotification], permission: UNAuthorizationStatus) {
#if DEBUG
        guard let task = ProcessInfo.processInfo.environment["ALONG_NOTIFICATION_PROBE_TASK"] else { return }
        func matches(_ r: UNNotificationRequest)->Bool { (r.content.userInfo["along"] as? [String:Any])?["taskId"] as? String == task }
        var state = ["checkedAt":ISO8601DateFormatter().string(from:Date()),"authorized":String([.authorized,.provisional,.ephemeral].contains(permission)),
                     "pending":String(pending.filter(matches).count),"scheduledFor":"","nextTriggerDate":"",
                     "repeats":"","timezone":"","weekday":"","hour":"","minute":""]
        if let request = pending.first(where:matches), let date = (request.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate() {
            state["scheduledFor"] = ISO8601DateFormatter().string(from:date)
            state["nextTriggerDate"] = ISO8601DateFormatter().string(from:date)
            if let trigger=request.trigger as? UNCalendarNotificationTrigger {
                state["repeats"]=String(trigger.repeats)
                state["timezone"]=trigger.dateComponents.timeZone?.identifier
                state["weekday"]=trigger.dateComponents.weekday.map { String(($0+5)%7+1) } ?? ""
                state["hour"]=trigger.dateComponents.hour.map(String.init) ?? ""
                state["minute"]=trigger.dateComponents.minute.map(String.init) ?? ""
            }
        }
        if let notice = delivered.last(where:{ matches($0.request) }) { state["deliveredAt"] = ISO8601DateFormatter().string(from:notice.date) }
        updateProbe(task,state)
#endif
    }
}
