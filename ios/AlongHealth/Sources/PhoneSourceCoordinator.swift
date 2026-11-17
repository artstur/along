import Foundation
import CryptoKit
import Security
import CoreFoundation
#if canImport(UIKit)
import UIKit
#endif

enum PhoneSourceCoordinatorError: String, LocalizedError {
    case busy, pairingUnavailable, authorizationChanged, hostUnavailable, invalidResponse, storageUnavailable, credentialsUnavailable, credentialDeletionFailed, protectedDataUnavailable, cancelled
    var errorDescription: String? {
        switch self {
        case .busy: "当前连接操作尚未完成，请稍后重试。"
        case .pairingUnavailable: "请先连接已配对的 Mac。"
        case .authorizationChanged: "目标或授权已变化，请重新打开连接页面。"
        case .hostUnavailable: "Mac 暂时未能接收设备数据，已保存的数据会保留并重试。"
        case .invalidResponse: "连接状态无法验证，请稍后重试。"
        case .storageUnavailable: "iPhone 无法安全保存连接状态，请稍后重试。"
        case .credentialsUnavailable: "iPhone 上没有可用的 OKX 凭证，请重新连接。"
        case .credentialDeletionFailed: "已停止读取，但 iPhone 凭证尚未确认删除；请解锁后重试断开。"
        case .protectedDataUnavailable: "请解锁 iPhone 后重试连接。"
        case .cancelled: "已取消连接操作。"
        }
    }
}

@MainActor protocol PhoneSourceCredentialStore {
    func load(account: String) throws -> OKXDeviceCredentials?
    func save(_ credentials: OKXDeviceCredentials, account: String) throws
    func delete(account: String) throws
}

@MainActor protocol PhoneSourceStateStore {
    func load(scope: String) throws -> [String: Any]?
    func save(_ state: [String: Any], scope: String) throws
    func scopes() throws -> [String]
}

/// Native authorization, collection and durable delivery share one scope record.
/// Neither its queue nor its transport ever receives a credential dictionary.
@MainActor final class PhoneSourceCoordinator {
    static let shared = PhoneSourceCoordinator()
    typealias Transport = @MainActor ([String: Any]) async throws -> [String: Any]

    private let client: OKXDeviceClient
    private let transport: Transport
    private let keychain: PhoneSourceCredentialStore
    private let storage: PhoneSourceStateStore
    private let connection: () -> [String: String]?
    private let protectedDataAvailable: () -> Bool
    private let now: () -> Date
    private var operations: [String: UUID] = [:]
    private var unavailableOperations = Set<UUID>()
    private var blockedScopes = Set<String>()
    private var collections: [String: (UUID, Task<OKXDeviceObservation, Error>)] = [:]

    init(client: OKXDeviceClient = OKXDeviceClient(), transport: Transport? = nil,
         keychain: PhoneSourceCredentialStore? = nil, storage: PhoneSourceStateStore? = nil,
         connection: (() -> [String: String]?)? = nil, protectedDataAvailable: (() -> Bool)? = nil, now: (() -> Date)? = nil) {
        self.client = client
        self.transport = transport ?? { try await AlongWebView.Coordinator.agentRequest($0, privateSourceRequest: true) }
        self.keychain = keychain ?? PhoneSourceKeychain()
        self.storage = storage ?? PhoneSourceFiles()
        self.connection = connection ?? { AlongConnectionStore.load() }
        self.protectedDataAvailable = protectedDataAvailable ?? {
#if canImport(UIKit)
            UIApplication.shared.isProtectedDataAvailable
#else
            true
#endif
        }
        self.now = now ?? { Date() }
    }

    func status(goalID: String) async throws -> [String: Any] {
        let operation = try begin(goalID)
        defer { end(operation) }
        guard var state = try load(operation) else { return Self.disconnected() }
        if blockedScopes.contains(operation.scope) { try revoke(&state, operation) }
        try cleanup(&state, operation)
        try await recoverRevocation(&state, operation)
        if state["phase"] as? String == "connected", let account = state["credentialAccount"] as? String,
           try readCredentials(account) == nil { try revoke(&state, operation) }
        if state["phase"] as? String == "collecting", let grant = state["grantId"] as? String,
           let account = state["credentialAccount"] as? String, let credentials = try readCredentials(account),
           Self.age(state["lastAttemptAt"], now: now()) >= 60 {
            try await reconcile(&state, operation)
            if state["phase"] as? String == "collecting" {
                state["lastAttemptAt"] = Self.iso(now())
                try save(state, operation)
                let site = try siteFor(state)
                do {
                    let observation = try await collect(site: site, credentials: credentials, operation: operation, grant: grant)
                    try commit(observation, credentials: credentials, state: &state, operation: operation)
                } catch OKXDeviceClientError.permissionDenied {
                    try revoke(&state, operation)
                }
            }
        }
        try await retryDelivery(&state, operation)
        try await reconcile(&state, operation)
        return try snapshot(state, operation)
    }

    func connect(goalID: String, site: OKXDeviceSite, credentials: OKXDeviceCredentials) async throws -> [String: Any] {
        let operation = try begin(goalID)
        defer { end(operation) }
        let initialRecord = try recordBytes(load(operation))
        let context = try await call(["action": "context", "provider": "okx", "goalId": goalID], operation)
        guard context["provider"] as? String == "okx", context["goalId"] as? String == goalID,
              let user = context["userId"] as? String, Self.validID(user),
              let device = context["deviceId"] as? String, Self.validID(device) else { throw PhoneSourceCoordinatorError.invalidResponse }
        // A delayed context from another coordinator instance must not replace
        // a newer durable intent. There is no await between this check and save.
        guard try recordBytes(load(operation)) == initialRecord else { throw PhoneSourceCoordinatorError.authorizationChanged }
        guard let expectedGrant = context["currentGrantId"],
              expectedGrant is NSNull || (expectedGrant as? String).map(Self.validHash) == true else { throw PhoneSourceCoordinatorError.invalidResponse }
        var state = try load(operation) ?? [:]
        let retry = ["opening", "collecting"].contains(state["phase"] as? String ?? "") &&
            state["userId"] as? String == user && state["deviceId"] as? String == device
        if !retry {
            let accounts = Self.accounts(state)
            let sameOwner = state["userId"] as? String == user && state["deviceId"] as? String == device
            let previousGrant = sameOwner ? (state["grantId"] as? String ?? state["previousGrantId"] as? String) : nil
            let sequence = sameOwner ? (state["sequence"] as? Int ?? 0) : 0
            state = ["version": 1, "provider": "okx", "goalId": goalID, "binding": operation.binding,
                     "userId": user, "deviceId": device, "site": site.rawValue,
                     "requestId": "open-" + UUID().uuidString.lowercased(), "expectedGrantId": expectedGrant, "phase": "opening", "sequence": sequence,
                     "pending": [], "held": [], "deletionAccounts": accounts]
            if let previousGrant { state["previousGrantId"] = previousGrant }
        } else { state["site"] = site.rawValue }
        try save(state, operation) // The explicit open intent is durable before it can rotate the Host grant.
        try cleanup(&state, operation)
        blockedScopes.remove(operation.scope) // Only a new explicit connect may replace a failed revocation intent.
        let requestID = state["requestId"] as! String
        try checkRecord(state, operation)
        let opened = try await call(["action": "open", "provider": "okx", "goalId": goalID, "requestId": requestID, "expectedGrantId": state["expectedGrantId"]!], operation)
        try checkRecord(state, operation)
        guard opened["provider"] as? String == "okx", opened["goalId"] as? String == goalID,
              opened["userId"] as? String == user, opened["deviceId"] as? String == device,
              let grant = opened["grantId"] as? String, Self.validHash(grant),
              ["pending", "connected"].contains(opened["state"] as? String ?? "") else {
            try stop(&state, operation)
            throw PhoneSourceCoordinatorError.authorizationChanged
        }
        state["grantId"] = grant
        state.removeValue(forKey: "previousGrantId")
        state["credentialAccount"] = Self.account(state, grant: grant)
        state["phase"] = "collecting"
        try save(state, operation)
        do {
            let observation = try await collect(site: site, credentials: credentials, operation: operation, grant: grant)
            try commit(observation, credentials: credentials, state: &state, operation: operation)
        } catch OKXDeviceClientError.permissionDenied {
            try revoke(&state, operation)
            try await retryDelivery(&state, operation)
            throw OKXDeviceClientError.permissionDenied
        }
        try await retryDelivery(&state, operation)
        guard state["phase"] as? String == "connected" else { throw PhoneSourceCoordinatorError.authorizationChanged }
        return try snapshot(state, operation)
    }

    func refresh(goalID: String) async throws -> [String: Any] {
        let operation = try begin(goalID)
        defer { end(operation) }
        guard var state = try load(operation) else { throw PhoneSourceCoordinatorError.credentialsUnavailable }
        if blockedScopes.contains(operation.scope) {
            try revoke(&state, operation)
            try await retryDelivery(&state, operation)
            return try snapshot(state, operation)
        }
        try cleanup(&state, operation)
        try await retryDelivery(&state, operation)
        try await reconcile(&state, operation)
        guard ["connected", "collecting"].contains(state["phase"] as? String ?? ""),
              let grant = state["grantId"] as? String, let account = state["credentialAccount"] as? String else { throw PhoneSourceCoordinatorError.credentialsUnavailable }
        guard let credentials = try readCredentials(account) else {
            try revoke(&state, operation)
            try await retryDelivery(&state, operation)
            throw PhoneSourceCoordinatorError.credentialsUnavailable
        }
        state["lastAttemptAt"] = Self.iso(now())
        try save(state, operation)
        do {
            let observation = try await collect(site: siteFor(state), credentials: credentials, operation: operation, grant: grant)
            try commit(observation, credentials: state["phase"] as? String == "collecting" ? credentials : nil, state: &state, operation: operation)
        } catch OKXDeviceClientError.permissionDenied {
            try revoke(&state, operation)
            try await retryDelivery(&state, operation)
            throw OKXDeviceClientError.permissionDenied
        }
        try await retryDelivery(&state, operation)
        guard state["phase"] as? String == "connected" else { throw PhoneSourceCoordinatorError.authorizationChanged }
        return try snapshot(state, operation)
    }

    func disconnect(goalID: String) async throws -> [String: Any] {
        let operation = try begin(goalID, preempt: true)
        defer { end(operation) }
        guard var state = try load(operation) else { return Self.disconnected() }
        try revoke(&state, operation) // Tombstone and stable event are committed before key deletion or network.
        try await recoverRevocation(&state, operation)
        try await retryDelivery(&state, operation)
        return try snapshot(state, operation)
    }

    func resumeForeground() {
        guard protectedDataAvailable(), let pair = connection(), let binding = try? Self.binding(pair), let scopes = try? storage.scopes() else { return }
        Task { @MainActor in
            for scope in scopes {
                guard let state = try? storage.load(scope: scope), state["binding"] as? String == binding,
                      let goal = state["goalId"] as? String, Self.validID(goal), operations[goal] == nil else { continue }
                do {
                    if state["phase"] as? String == "connected", Self.age(state["lastCollectedAt"] ?? state["lastSyncedAt"], now: now()) >= 300,
                       Self.age(state["lastAttemptAt"], now: now()) >= 60 { _ = try await refresh(goalID: goal) }
                    else { _ = try await status(goalID: goal) }
                } catch { /* Durable state is retried on the next foreground opportunity. */ }
            }
        }
    }

    private struct Operation { let goal: String; let binding: String; let scope: String; let id: UUID }
    private func begin(_ goal: String, preempt: Bool = false) throws -> Operation {
        guard protectedDataAvailable() else { throw PhoneSourceCoordinatorError.protectedDataUnavailable }
        guard Self.validID(goal), let pair = connection() else { throw PhoneSourceCoordinatorError.pairingUnavailable }
        let binding = try Self.binding(pair)
        guard preempt || operations[goal] == nil else { throw PhoneSourceCoordinatorError.busy }
        if preempt { collections.removeValue(forKey: goal)?.1.cancel() }
        let id = UUID(); operations[goal] = id
        return Operation(goal: goal, binding: binding, scope: Self.hash(["phone-source-v1", "okx", binding, goal]), id: id)
    }
    private func end(_ operation: Operation) { unavailableOperations.remove(operation.id); if operations[operation.goal] == operation.id { operations.removeValue(forKey: operation.goal) } }
    private func check(_ operation: Operation, grant: String? = nil) throws {
        guard !Task.isCancelled else { throw PhoneSourceCoordinatorError.cancelled }
        guard protectedDataAvailable() else { throw PhoneSourceCoordinatorError.protectedDataUnavailable }
        guard operations[operation.goal] == operation.id, let pair = connection(), try Self.binding(pair) == operation.binding else {
            throw PhoneSourceCoordinatorError.authorizationChanged
        }
        if let grant {
            guard !blockedScopes.contains(operation.scope) else { throw PhoneSourceCoordinatorError.credentialDeletionFailed }
            guard let state = try load(operation), state["grantId"] as? String == grant,
                  !["revoking", "stopped"].contains(state["phase"] as? String ?? "") else { throw PhoneSourceCoordinatorError.authorizationChanged }
        }
    }
    private func load(_ operation: Operation) throws -> [String: Any]? {
        do {
            guard let state = try storage.load(scope: operation.scope) else { return nil }
            guard Self.validState(state, operation) else { throw PhoneSourceCoordinatorError.storageUnavailable }
            return state
        } catch { throw PhoneSourceCoordinatorError.storageUnavailable }
    }
    private func recordBytes(_ state: [String: Any]?) throws -> Data? {
        guard let state else { return nil }
        do { return try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) }
        catch { throw PhoneSourceCoordinatorError.storageUnavailable }
    }
    private func checkRecord(_ state: [String: Any], _ operation: Operation) throws {
        try check(operation)
        guard let current = try load(operation), current["requestId"] as? String == state["requestId"] as? String,
              current["grantId"] as? String == state["grantId"] as? String,
              current["sequence"] as? Int == state["sequence"] as? Int,
              current["phase"] as? String == state["phase"] as? String else { throw PhoneSourceCoordinatorError.authorizationChanged }
    }
    private func save(_ state: [String: Any], _ operation: Operation) throws {
        try check(operation)
        guard Self.validState(state, operation) else { throw PhoneSourceCoordinatorError.storageUnavailable }
        do { try storage.save(state, scope: operation.scope) } catch { throw PhoneSourceCoordinatorError.storageUnavailable }
    }
    private func call(_ body: [String: Any], _ operation: Operation) async throws -> [String: Any] {
        try check(operation)
        guard !unavailableOperations.contains(operation.id) else { throw PhoneSourceCoordinatorError.hostUnavailable }
        guard let pair = connection() else { throw PhoneSourceCoordinatorError.pairingUnavailable }
        var input: [String: Any] = pair.mapValues { $0 as Any }
        input["path"] = "/sources/device"; input["body"] = body
        let result: [String: Any]
        do { result = try await transport(input) }
        catch {
            try check(operation)
            if case let AgentBridgeError.receipt(receipt) = error { return receipt }
            if case let AgentBridgeError.server(message) = error,
               ["目标或配对已变化，请重新连接。", "配对已变更", "配对已变化", "配对已变化，请重新打开连接", "请先配对这台 Mac", "这个目标当前无法连接 OKX，请同步目标后重试"].contains(message) {
                throw PhoneSourceCoordinatorError.authorizationChanged
            }
            unavailableOperations.insert(operation.id)
            throw PhoneSourceCoordinatorError.hostUnavailable
        }
        try check(operation)
        return result
    }
    private func collect(site: OKXDeviceSite, credentials: OKXDeviceCredentials, operation: Operation, grant: String) async throws -> OKXDeviceObservation {
        try check(operation, grant: grant)
        let collector = OKXDeviceDataCollector(client: client, site: site, credentials: credentials)
        let task = Task { try await collector.collect() }
        collections[operation.goal] = (operation.id, task)
        defer { if collections[operation.goal]?.0 == operation.id { collections.removeValue(forKey: operation.goal) } }
        let result: OKXDeviceObservation
        do { result = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() } }
        catch {
            try check(operation, grant: grant)
            if let safe = error as? OKXDeviceClientError { throw safe }
            throw PhoneSourceCoordinatorError.invalidResponse
        }
        try check(operation, grant: grant)
        guard result.permission == "read_only", result.summary.tradingEquityUsd.isFinite,
              result.summary.assetCount >= 0, result.summary.positionCount >= 0,
              result.capturedAt.timeIntervalSince1970.isFinite else { throw PhoneSourceCoordinatorError.invalidResponse }
        return result
    }
    private func commit(_ observation: OKXDeviceObservation, credentials: OKXDeviceCredentials?, state: inout [String: Any], operation: Operation) throws {
        guard let grant = state["grantId"] as? String, let account = state["credentialAccount"] as? String else { throw PhoneSourceCoordinatorError.invalidResponse }
        try check(operation, grant: grant)
        try checkRecord(state, operation)
        var next = state
        let sequence = try Self.nextSequence(state)
        let eventID = "source-" + UUID().uuidString.lowercased()
        let summary: [String: Any] = ["tradingEquityUsd": observation.summary.tradingEquityUsd, "assetCount": observation.summary.assetCount, "positionCount": observation.summary.positionCount]
        let observedAt = Self.iso(observation.capturedAt)
        let body: [String: Any] = ["action": "publish", "provider": "okx", "goalId": operation.goal, "grantId": grant,
                                   "eventId": eventID, "sequence": sequence, "observedAt": observedAt, "permission": "read_only", "summary": summary]
        next["sequence"] = sequence; next["phase"] = "connected"; next["summary"] = summary; next["lastSyncedAt"] = observedAt
        next["lastCollectedAt"] = Self.iso(now())
        do { try DeviceEventQueue.append(["event_id": eventID, "body": body], to: &next) }
        catch { throw PhoneSourceCoordinatorError.storageUnavailable }
        if let credentials {
            do { try keychain.save(credentials, account: account) }
            catch {
                try? stop(&state, operation)
                do { try keychain.delete(account: account) } catch { throw PhoneSourceCoordinatorError.credentialDeletionFailed }
                throw PhoneSourceCoordinatorError.storageUnavailable
            }
        }
        do { try save(next, operation); state = next }
        catch {
            if credentials != nil {
                // The earlier collecting record already names this Keychain item,
                // so an interruption here is recoverable without exposing a connection.
                try? stop(&state, operation)
                do { try keychain.delete(account: account) } catch { throw PhoneSourceCoordinatorError.credentialDeletionFailed }
            }
            throw PhoneSourceCoordinatorError.storageUnavailable
        }
    }
    private func revoke(_ state: inout [String: Any], _ operation: Operation) throws {
        try checkRecord(state, operation)
        blockedScopes.insert(operation.scope)
        do {
        if state["phase"] as? String != "revoking" {
            state["phase"] = "revoking"
            state.removeValue(forKey: "summary"); state.removeValue(forKey: "lastSyncedAt")
            state["pending"] = []
            state["deletionAccounts"] = Self.accounts(state)
            if let grant = state["grantId"] as? String {
                let sequence = try Self.nextSequence(state), id = "revoke-" + UUID().uuidString.lowercased()
                state["sequence"] = sequence
                do {
                    try DeviceEventQueue.append(["event_id": id, "body": ["action": "disconnect", "provider": "okx", "goalId": operation.goal,
                        "grantId": grant, "eventId": id, "sequence": sequence]], to: &state)
                } catch { throw PhoneSourceCoordinatorError.storageUnavailable }
            }
            try save(state, operation)
        }
        try cleanup(&state, operation)
        } catch PhoneSourceCoordinatorError.storageUnavailable {
            // Persistence failure must not reactivate a credential on restart.
            // This is explicitly an incomplete disconnect, never a success receipt.
            try eraseAfterPersistenceFailure(state, operation)
            throw PhoneSourceCoordinatorError.storageUnavailable
        }
    }
    private func recoverRevocation(_ state: inout [String: Any], _ operation: Operation) async throws {
        guard state["phase"] as? String == "revoking", state["grantId"] == nil,
              let requestID = state["requestId"] as? String else { return }
        try checkRecord(state, operation)
        let remote: [String: Any]
        do { remote = try await call(["action": "status", "provider": "okx", "goalId": operation.goal, "requestId": requestID], operation) }
        catch PhoneSourceCoordinatorError.hostUnavailable { return }
        catch PhoneSourceCoordinatorError.authorizationChanged { try stop(&state, operation); return }
        try checkRecord(state, operation)
        guard remote["provider"] as? String == "okx" else { throw PhoneSourceCoordinatorError.invalidResponse }
        // Status(requestId) resolves only the already durable explicit intent. It never opens a grant.
        // If the new open never reached Host, the same owner's last known grant
        // still needs revoking. The per-scope sequence remains monotonic.
        guard let grant = remote["grantId"] as? String ?? state["previousGrantId"] as? String else { return }
        guard Self.validHash(grant) else { throw PhoneSourceCoordinatorError.invalidResponse }
        state["grantId"] = grant; state["credentialAccount"] = Self.account(state, grant: grant)
        state.removeValue(forKey: "previousGrantId")
        let sequence = try Self.nextSequence(state), id = "revoke-" + UUID().uuidString.lowercased()
        state["sequence"] = sequence
        do {
            try DeviceEventQueue.append(["event_id": id, "body": ["action": "disconnect", "provider": "okx", "goalId": operation.goal,
                "grantId": grant, "eventId": id, "sequence": sequence]], to: &state)
        } catch { throw PhoneSourceCoordinatorError.storageUnavailable }
        try save(state, operation)
    }
    private func stop(_ state: inout [String: Any], _ operation: Operation) throws {
        try checkRecord(state, operation)
        blockedScopes.insert(operation.scope)
        state["phase"] = "stopped"
        state.removeValue(forKey: "receivedSequence")
        state.removeValue(forKey: "summary"); state.removeValue(forKey: "lastSyncedAt")
        var held = state["held"] as? [[String: Any]] ?? []
        held.append(contentsOf: (state["pending"] as? [[String: Any]] ?? []).map { ["event": $0, "receipt": ["status": "stale"]] })
        state["held"] = Array(held.suffix(100)); state["pending"] = []
        state["deletionAccounts"] = Self.accounts(state)
        do { try save(state, operation); try cleanup(&state, operation) }
        catch PhoneSourceCoordinatorError.storageUnavailable {
            try eraseAfterPersistenceFailure(state, operation)
            throw PhoneSourceCoordinatorError.storageUnavailable
        }
    }
    private func eraseAfterPersistenceFailure(_ state: [String: Any], _ operation: Operation) throws {
        try check(operation)
        var failed = false
        for account in Self.accounts(state) { do { try keychain.delete(account: account) } catch { failed = true } }
        guard !failed else { throw PhoneSourceCoordinatorError.credentialDeletionFailed }
        // Keep the in-memory block until a durable tombstone succeeds. If both
        // stores fail, revocation across process restarts cannot be guaranteed.
    }
    private func cleanup(_ state: inout [String: Any], _ operation: Operation) throws {
        for account in state["deletionAccounts"] as? [String] ?? [] {
            try check(operation)
            do { try keychain.delete(account: account) } catch { throw PhoneSourceCoordinatorError.credentialDeletionFailed }
            var accounts = state["deletionAccounts"] as? [String] ?? []; accounts.removeAll { $0 == account }
            state["deletionAccounts"] = accounts
            try save(state, operation)
        }
        if ["revoking", "stopped"].contains(state["phase"] as? String ?? "") { blockedScopes.remove(operation.scope) }
    }
    private func retryDelivery(_ state: inout [String: Any], _ operation: Operation) async throws {
        do { try await drain(&state, operation) }
        catch PhoneSourceCoordinatorError.hostUnavailable { unavailableOperations.insert(operation.id) /* Keep committed facts and avoid repeating an unreachable Host within this operation. */ }
        catch PhoneSourceCoordinatorError.authorizationChanged { try stop(&state, operation) }
    }
    private func drain(_ state: inout [String: Any], _ operation: Operation) async throws {
        try cleanup(&state, operation)
        while let event = (state["pending"] as? [[String: Any]])?.first,
              let body = event["body"] as? [String: Any] {
            try checkRecord(state, operation)
            let receipt = try await call(body, operation)
            try checkRecord(state, operation)
            var next = state
            let disposition = DeviceEventQueue.advance(&next, receipt: receipt)
            if disposition == .retry { throw PhoneSourceCoordinatorError.hostUnavailable }
            if disposition == .held {
                state = next
                try stop(&state, operation)
                return
            }
            next["receivedSequence"] = body["sequence"]
            if body["action"] as? String == "disconnect" { next["phase"] = "stopped" }
            try save(next, operation); state = next
        }
    }
    private func reconcile(_ state: inout [String: Any], _ operation: Operation) async throws {
        guard ["connected", "collecting"].contains(state["phase"] as? String ?? "") else { return }
        try checkRecord(state, operation)
        let remote: [String: Any]
        do { remote = try await call(["action": "status", "provider": "okx", "goalId": operation.goal], operation) }
        catch PhoneSourceCoordinatorError.hostUnavailable { return }
        catch PhoneSourceCoordinatorError.authorizationChanged { try stop(&state, operation); return }
        try checkRecord(state, operation)
        guard remote["provider"] as? String == "okx", let phase = remote["state"] as? String,
              ["pending", "connected", "disconnected"].contains(phase) else { throw PhoneSourceCoordinatorError.invalidResponse }
        if phase == "disconnected" || remote["grantId"] as? String != state["grantId"] as? String { try stop(&state, operation) }
    }
    private func snapshot(_ state: [String: Any], _ operation: Operation) throws -> [String: Any] {
        try checkRecord(state, operation)
        guard !blockedScopes.contains(operation.scope) else { throw PhoneSourceCoordinatorError.credentialDeletionFailed }
        let connected = state["phase"] as? String == "connected"
        let sequence = state["sequence"] as? Int ?? 0, received = state["receivedSequence"] as? Int ?? -1
        let phase = state["phase"] as? String
        let syncState: String
        if connected { syncState = sequence > 0 && received == sequence ? "received" : "pending" }
        else if phase == "revoking" { syncState = "pending" }
        else if phase == "stopped", sequence > 0, received == sequence { syncState = "received" }
        else { syncState = "none" }
        var view: [String: Any] = ["provider": "okx", "state": connected ? "connected" : "disconnected", "syncState": syncState]
        if connected {
            guard let account = state["credentialAccount"] as? String, try readCredentials(account) != nil,
                  let summary = state["summary"] as? [String: Any], let date = state["lastSyncedAt"] as? String else {
                throw PhoneSourceCoordinatorError.credentialsUnavailable
            }
            view["summary"] = summary; view["lastSyncedAt"] = date
        }
        return view
    }
    private func readCredentials(_ account: String) throws -> OKXDeviceCredentials? {
        do { return try keychain.load(account: account) } catch { throw PhoneSourceCoordinatorError.credentialsUnavailable }
    }
    private func siteFor(_ state: [String: Any]) throws -> OKXDeviceSite {
        guard let raw = state["site"] as? String, let site = OKXDeviceSite(rawValue: raw) else { throw PhoneSourceCoordinatorError.invalidResponse }
        return site
    }
    private static func disconnected() -> [String: Any] { ["provider": "okx", "state": "disconnected", "syncState": "none"] }
    private static func hash(_ values: [String]) -> String { SHA256.hash(data: Data(values.joined(separator: "\n").utf8)).map { String(format: "%02x", $0) }.joined() }
    private static func binding(_ pair: [String: String]) throws -> String {
        guard let pin = pair["fingerprint"], let token = pair["token"], validHash(pin.lowercased()), validHash(token.lowercased()) else { throw PhoneSourceCoordinatorError.pairingUnavailable }
        return hash([pin.uppercased(), token.lowercased()]) // A Mac address change is transport, not a new pairing.
    }
    private static func validHash(_ value: String) -> Bool { value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
    private static func validID(_ value: String) -> Bool { value.range(of: #"^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$"#, options: .regularExpression) == value.startIndex..<value.endIndex }
    private static func iso(_ date: Date) -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: date) }
    private static func validDate(_ value: Any?) -> Bool { guard let text = value as? String else { return false }; let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.date(from: text) != nil || ISO8601DateFormatter().date(from: text) != nil }
    private static func age(_ value: Any?, now: Date) -> TimeInterval { guard let text = value as? String else { return .infinity }; let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; guard let date = f.date(from: text) ?? ISO8601DateFormatter().date(from: text) else { return .infinity }; return now.timeIntervalSince(date) }
    private static func nextSequence(_ state: [String: Any]) throws -> Int { guard let current = state["sequence"] as? Int, current >= 0, current < 9_007_199_254_740_991 else { throw PhoneSourceCoordinatorError.storageUnavailable }; return current + 1 }
    private static func integer(_ value: Any?) -> Int? { guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }; let value = number.intValue; return NSNumber(value: value).compare(number) == .orderedSame ? value : nil }
    private static func account(_ state: [String: Any], grant: String) -> String { hash(["okx", state["userId"] as? String ?? "", state["deviceId"] as? String ?? "", state["goalId"] as? String ?? "", state["binding"] as? String ?? "", grant]) }
    private static func accounts(_ state: [String: Any]) -> [String] { Array(Set((state["deletionAccounts"] as? [String] ?? []) + ((state["credentialAccount"] as? String).map { [$0] } ?? []))) }
    private static func validState(_ state: [String: Any], _ operation: Operation) -> Bool {
        let fields: Set<String> = ["version", "provider", "goalId", "binding", "userId", "deviceId", "site", "requestId", "expectedGrantId", "phase", "sequence", "pending", "held", "deletionAccounts", "grantId", "previousGrantId", "credentialAccount", "summary", "lastSyncedAt", "receivedSequence", "lastAttemptAt", "lastCollectedAt"]
        guard Set(state.keys).isSubset(of: fields), integer(state["version"]) == 1, state["provider"] as? String == "okx", state["goalId"] as? String == operation.goal,
              state["binding"] as? String == operation.binding, let user = state["userId"] as? String, validID(user),
              let device = state["deviceId"] as? String, validID(device), let request = state["requestId"] as? String, validID(request),
              let site = state["site"] as? String, OKXDeviceSite(rawValue: site) != nil,
              ["opening", "collecting", "connected", "revoking", "stopped"].contains(state["phase"] as? String ?? ""),
              let sequence = integer(state["sequence"]), sequence >= 0, sequence <= 9_007_199_254_740_991,
              let pending = state["pending"] as? [[String: Any]], pending.count <= 200,
              let held = state["held"] as? [[String: Any]], held.count <= 100,
              let deletions = state["deletionAccounts"] as? [String], deletions.count <= 8, deletions.allSatisfy(validHash) else { return false }
        guard let expected = state["expectedGrantId"], expected is NSNull || (expected as? String).map(validHash) == true else { return false }
        if state["receivedSequence"] != nil { guard let received = integer(state["receivedSequence"]), received >= 0, received <= sequence else { return false } }
        if state["lastAttemptAt"] != nil && !validDate(state["lastAttemptAt"]) { return false }
        if state["lastCollectedAt"] != nil && !validDate(state["lastCollectedAt"]) { return false }
        if let previous = state["previousGrantId"] { guard let hash = previous as? String, validHash(hash) else { return false } }
        if let grant = state["grantId"] as? String {
            guard validHash(grant), state["credentialAccount"] as? String == account(state, grant: grant) else { return false }
        } else if state["credentialAccount"] != nil || state["grantId"] != nil || ["collecting", "connected"].contains(state["phase"] as? String ?? "") { return false }
        if state["phase"] as? String == "connected", (!validSummary(state["summary"]) || !validDate(state["lastSyncedAt"])) { return false }
        return pending.allSatisfy { event in
            guard Set(event.keys) == ["event_id", "body"], let id = event["event_id"] as? String, validID(id),
                  let body = event["body"] as? [String: Any], body["eventId"] as? String == id,
                  body["provider"] as? String == "okx", body["goalId"] as? String == operation.goal,
                  body["grantId"] as? String == state["grantId"] as? String,
                  let seq = integer(body["sequence"]), seq > 0, seq <= sequence else { return false }
            let common: Set<String> = ["action", "provider", "goalId", "grantId", "eventId", "sequence"]
            if body["action"] as? String == "disconnect" { return Set(body.keys) == common }
            return body["action"] as? String == "publish" && Set(body.keys) == common.union(["observedAt", "permission", "summary"]) &&
                body["permission"] as? String == "read_only" && validDate(body["observedAt"]) && validSummary(body["summary"])
        }
    }
    private static func validSummary(_ value: Any?) -> Bool {
        guard let row = value as? [String: Any], Set(row.keys) == ["tradingEquityUsd", "assetCount", "positionCount"],
              let data = try? JSONSerialization.data(withJSONObject: row), let summary = try? JSONDecoder().decode(OKXDeviceSummary.self, from: data) else { return false }
        return summary.tradingEquityUsd.isFinite && summary.assetCount >= 0 && summary.positionCount >= 0
    }
}

@MainActor private final class PhoneSourceKeychain: PhoneSourceCredentialStore {
    private let service = "com.artstur.AlongHealth.phone-source.okx.v1"
    private func query(_ account: String) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false] }
    func load(account: String) throws -> OKXDeviceCredentials? {
        var query = query(account); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data, let credentials = try? JSONDecoder().decode(OKXDeviceCredentials.self, from: data) else { throw PhoneSourceCoordinatorError.credentialsUnavailable }
        return credentials
    }
    func save(_ credentials: OKXDeviceCredentials, account: String) throws {
        let data: Data
        do { data = try JSONEncoder().encode(credentials) } catch { throw PhoneSourceCoordinatorError.storageUnavailable }
        let key = query(account), attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(key as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = key; item.merge(attributes) { _, new in new }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw PhoneSourceCoordinatorError.storageUnavailable }
        } else if status != errSecSuccess { throw PhoneSourceCoordinatorError.storageUnavailable }
    }
    func delete(account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PhoneSourceCoordinatorError.credentialDeletionFailed }
    }
}

@MainActor private final class PhoneSourceFiles: PhoneSourceStateStore {
    private func directory() throws -> URL {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("AlongPhoneSources", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o700])
        var protected = directory, values = URLResourceValues(); values.isExcludedFromBackup = true; try protected.setResourceValues(values)
        return directory
    }
    private func url(_ scope: String) throws -> URL {
        guard scope.utf8.count == 64, scope.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw PhoneSourceCoordinatorError.storageUnavailable }
        return try directory().appendingPathComponent(scope + ".json")
    }
    func load(scope: String) throws -> [String: Any]? {
        do {
            let url = try url(scope), attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular, (attributes[.size] as? NSNumber)?.intValue ?? Int.max <= 1024 * 1024 else { throw PhoneSourceCoordinatorError.storageUnavailable }
            let data = try Data(contentsOf: url)
            guard let state = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw PhoneSourceCoordinatorError.storageUnavailable }
            return state
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }
    func save(_ state: [String: Any], scope: String) throws {
        let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
        guard data.count <= 1024 * 1024 else { throw PhoneSourceCoordinatorError.storageUnavailable }
        try data.write(to: url(scope), options: [.atomic, .completeFileProtection])
    }
    func scopes() throws -> [String] { try FileManager.default.contentsOfDirectory(at: directory(), includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }.map { $0.deletingPathExtension().lastPathComponent } }
}
