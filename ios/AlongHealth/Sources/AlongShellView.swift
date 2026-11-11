import SwiftUI
import WebKit
import CryptoKit
import Security
import CFNetwork
import Network
import ObjectiveC
import UserNotifications

@main
struct AlongHealthApp: App {
    @StateObject private var bridge = AlongBridgeModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ZStack {
                AlongWebView(bridge: bridge)
                    .ignoresSafeArea(edges: .bottom)
                if bridge.webLoading {
                    ProgressView("正在加载 Along…")
                        .foregroundStyle(.secondary)
                } else if let error = bridge.webError {
                    ContentUnavailableView("页面暂时无法加载", systemImage: "wifi.exclamationmark",
                                           description: Text(error))
                }
            }
                .sheet(isPresented: $bridge.showSheet, onDismiss: { bridge.dismissIfPending() }) {
                    HealthSyncSheet(bridge: bridge)
                        .interactiveDismissDisabled(bridge.busy)
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { bridge.refreshHealth() }
                }
        }
    }
}

// 健康导入一次只允许一个：后来的请求也必须拿到明确的答复，不能被悄悄丢掉，
// 否则网页那边的 Promise 会永远悬着，用户只会看到「点了没反应」。
enum HealthImportAdmission {
    /// 返回 nil 表示可以开始导入；否则是必须答复给网页的失败结果。
    static func refusal(pending: String?) -> [String: Any]? {
        pending == nil ? nil : ["ok": false, "error": "已有健康数据导入正在进行"]
    }
}

@MainActor
final class AlongBridgeModel: ObservableObject {
    @Published var showSheet = false
    @Published var selection: Set<HealthMetric> = []
    @Published var preview: HealthSummary?
    @Published var busy = false
    @Published var errorMessage: String?
    @Published var webLoading = true
    @Published var webError: String?

    private let reader = HealthKitReader()
    private var requestID: String?
    private weak var webView: WKWebView?
    private var refreshing = false
    private var healthUpdateRequested = false
    private var healthRefreshRequests: [(id: String, view: WKWebView)] = []
    // 清除数据后，在途的读取不能再把旧摘要送回网页。
    private var healthEpoch = 0

    func attach(_ webView: WKWebView) {
        self.webView = webView
        startObservers()
        refreshHealth()
    }

    private var savedSelection: Set<HealthMetric> {
        Set((UserDefaults.standard.stringArray(forKey: "along.health.selectedTypes") ?? []).compactMap(HealthMetric.init(rawValue:)))
    }

    private var contextReviewAllowed: Bool {
        UserDefaults.standard.bool(forKey: "along.health.contextReview.v1")
    }

    private func startObservers() {
        let selected = savedSelection
        guard !selected.isEmpty else { return }
        reader.observe(selected) { [weak self] in
            Task { @MainActor in self?.refreshHealth() }
        }
    }

    func refreshHealth() {
        guard !savedSelection.isEmpty else { return }
        healthUpdateRequested = true
        startHealthRefresh()
    }

    func refreshSnapshot(id: String, webView: WKWebView) {
        guard !savedSelection.isEmpty else {
            deliver(id: id, result: ["ok": false, "code": "health_not_connected", "error": "请先连接 Apple Health"], to: webView)
            return
        }
        healthRefreshRequests.append((id, webView))
        startHealthRefresh()
    }

    private func startHealthRefresh() {
        guard !refreshing else { return }
        refreshing = true
        Task {
            defer { refreshing = false }
            // An update received during the read needs one fresh snapshot. Browser polls
            // share this queue so an older independent read cannot arrive last.
            while healthUpdateRequested || !healthRefreshRequests.isEmpty {
                let epoch = healthEpoch
                let publish = healthUpdateRequested
                let requests = healthRefreshRequests
                healthUpdateRequested = false
                healthRefreshRequests.removeAll()
                var result: [String: Any]
                do {
                    let summary = try await reader.read(savedSelection, requestPermission: false, includeContext: contextReviewAllowed)
                    let snapshot = summary.browserSnapshot(contextReviewAllowed: contextReviewAllowed)
                    if publish && epoch == healthEpoch { publishHealthSnapshot(snapshot) }
                    result = ["ok": true, "snapshot": snapshot]
                } catch {
                    if publish && epoch == healthEpoch { errorMessage = error.localizedDescription }
                    result = ["ok": false, "error": error.localizedDescription]
                }
                if epoch != healthEpoch { result = ["ok": false, "error": "健康数据选择已更新"] }
                for request in requests { deliver(id: request.id, result: result, to: request.view) }
            }
        }
    }

    private func publishHealthSnapshot(_ snapshot: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: snapshot),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('along-health-update', {detail: \(json)}))")
    }

    private func invalidateHealthRefreshes() {
        healthEpoch += 1
        healthUpdateRequested = false
        for request in healthRefreshRequests {
            deliver(id: request.id, result: ["ok": false, "error": "健康数据选择已更新"], to: request.view)
        }
        healthRefreshRequests.removeAll()
    }

    func clearHealth(id: String, webView: WKWebView) {
        // 清除本机保存的读取选择并停掉观察：只清网页里的摘要，下一轮刷新还会被读回来。
        UserDefaults.standard.removeObject(forKey: "along.health.selectedTypes")
        UserDefaults.standard.removeObject(forKey: "along.health.contextReview.v1")
        reader.stopObserving()
        selection = []
        preview = nil
        errorMessage = nil
        // 让在途的读取作废：它们返回时不能再把旧摘要送回网页。
        invalidateHealthRefreshes()
        deliver(id: id, result: ["ok": true], to: webView)
    }

    private func deliver(id: String, result: [String: Any], to view: WKWebView) {
        guard let arguments = try? JSONSerialization.data(withJSONObject: [id, result]),
              let json = String(data: arguments, encoding: .utf8) else { return }
        view.evaluateJavaScript("window.__alongHealthBridgeFinish(...\(json))")
    }

    func begin(id: String, webView: WKWebView) {
        // 在途导入已经有一个请求时，这次要明确答复，不能直接丢掉。
        if let refusal = HealthImportAdmission.refusal(pending: requestID) {
            deliver(id: id, result: refusal, to: webView)
            return
        }
        requestID = id
        self.webView = webView
        selection = savedSelection
        preview = nil
        errorMessage = nil
        showSheet = true
    }

    func readPreview() {
        guard !busy else { return }
        let selected = selection
        busy = true
        preview = nil
        errorMessage = nil
        Task {
            defer { busy = false }
            do {
                let summary = try await reader.read(selected)
                if selection == selected { preview = summary }
            }
            catch { errorMessage = error.localizedDescription }
        }
    }

    func selectAll() {
        guard !busy else { return }
        selection = Set(HealthMetric.allCases)
        preview = nil
        errorMessage = nil
    }

    func confirmImport() {
        guard !busy, let preview, preview.hasReadableValue else { return }
        invalidateHealthRefreshes()
        UserDefaults.standard.set(preview.selected.map(\.rawValue), forKey: "along.health.selectedTypes")
        UserDefaults.standard.set(true, forKey: "along.health.contextReview.v1")
        startObservers()
        finish(snapshot: preview.browserSnapshot(contextReviewAllowed: true))
    }

    func cancel() { finish(error: "已取消健康数据导入") }
    func dismissIfPending() { if requestID != nil { finish(error: "已取消健康数据导入") } }

    private func finish(snapshot: [String: Any]? = nil, error: String? = nil) {
        guard let id = requestID else { return }
        requestID = nil
        showSheet = false
        preview = nil
        let result: [String: Any] = snapshot.map { ["ok": true, "snapshot": $0] } ?? ["ok": false, "error": error ?? "已取消"]
        guard let arguments = try? JSONSerialization.data(withJSONObject: [id, result]),
              let json = String(data: arguments, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__alongHealthBridgeFinish(...\(json))")
    }
}

enum AlongConnectionStore {
    private static let legacyKey = "along.connection.v1"
    private static let service = "com.artstur.AlongHealth.connection"
    private static let account = "Along"

    static func load() -> [String: String]? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
           let data = item as? Data,
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let clean = clean(value) { return clean }

        guard let legacy = UserDefaults.standard.dictionary(forKey: legacyKey),
              let clean = clean(legacy) else { return nil }
        // 迁移到钥匙串成功之后才删旧键：写失败还照删，就只剩一份凭证，而且再也回不来。
        if save(clean.mapValues { $0 as Any }) != nil {
            UserDefaults.standard.removeObject(forKey: legacyKey)
        }
        return clean
    }

    @discardableResult
    static func save(_ value: [String: Any]) -> [String: String]? {
        guard let clean = clean(value),
              let data = try? JSONSerialization.data(withJSONObject: clean) else { return nil }
        let key: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(key as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = key
            item.merge(attributes) { _, new in new }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { return nil }
        } else if status != errSecSuccess { return nil }
        return clean
    }

#if DEBUG
    private static func wifiSubnet(for host: String) -> String {
        var peer = in_addr()
        var addresses: UnsafeMutablePointer<ifaddrs>?
        guard inet_pton(AF_INET, host, &peer) == 1, getifaddrs(&addresses) == 0 else { return "unavailable" }
        defer { freeifaddrs(addresses) }
        var cursor = addresses
        while let entry = cursor?.pointee {
            cursor = entry.ifa_next
            guard String(cString: entry.ifa_name) == "en0",
                  let address = entry.ifa_addr, address.pointee.sa_family == AF_INET,
                  let netmask = entry.ifa_netmask else { continue }
            let local = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr }
            let mask = netmask.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr }
            return (local & mask) == (peer.s_addr & mask) ? "same subnet" : "different subnet"
        }
        return "no Wi-Fi IPv4"
    }

    private static func checkLocalRoute(_ url: URL) async {
        guard let host = url.host, let port = NWEndpoint.Port("\(url.port ?? 443)") else { return }
        print("Along local Wi-Fi: \(wifiSubnet(for: host))")
        let parameters = NWParameters.tcp
        parameters.preferNoProxies = true
        let connection = NWConnection(host: NWEndpoint.Host(host), port: port, using: parameters)
        let queue = DispatchQueue(label: "Along.paired-host-route")
        let outcomes = AsyncStream<String> { continuation in
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: continuation.yield("reachable")
                case .failed: continuation.yield("failed")
                case .waiting where connection.currentPath?.unsatisfiedReason == .localNetworkDenied:
                    print("Along direct local route: waiting for local network access")
                default: break
                }
            }
            queue.asyncAfter(deadline: .now() + 15) {
                continuation.yield(connection.currentPath?.unsatisfiedReason == .localNetworkDenied ? "localNetworkDenied" : "timed out")
                continuation.finish()
            }
        }
        connection.start(queue: queue)
        for await outcome in outcomes {
            print("Along direct local route: \(outcome)")
            break
        }
        connection.stateUpdateHandler = nil
        connection.cancel()
    }

    static func bootstrapFromEnvironment() async {
        let environment = ProcessInfo.processInfo.environment
        if environment["ALONG_MIGRATE_URL"] != nil || environment["ALONG_MIGRATE_FINGERPRINT"] != nil {
            if let settings = try? await AlongWebView.Coordinator.notificationOperation(["action": "status"]),
               let status = settings["status"] as? String {
                print("Along notification authorization: \(status)")
            }
            guard let baseURL = environment["ALONG_MIGRATE_URL"],
                  let fingerprint = environment["ALONG_MIGRATE_FINGERPRINT"],
                  let saved = load(), let token = saved["token"],
                  saved["fingerprint"] == fingerprint.uppercased(),
                  let next = clean(["baseURL": baseURL, "fingerprint": fingerprint, "token": token]),
                  let url = URL(string: baseURL)
            else {
                print("Along host migration requires a matching stored pairing")
                return
            }
            await checkLocalRoute(url)
            var input: [String: Any] = next
            input["path"] = "/connection/verify"
            input["body"] = [:] as [String: Any]
            guard let result = try? await AlongWebView.Coordinator.agentRequest(input),
                  result["paired"] as? Bool == true, load() == saved, save(next) != nil else {
                print("Along host migration could not verify or persist the pairing")
                return
            }
            print("Along host migration verified and saved")
            return
        }
        guard let json = environment["ALONG_CONNECTION"],
              let data = json.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        _ = save(value)
    }
#endif

    private static func clean(_ value: [String: Any]) -> [String: String]? {
        guard let baseURL = value["baseURL"] as? String,
              let components = URLComponents(string: baseURL),
              components.scheme == "https", let host = components.host,
              host.split(separator: ".").count == 4,
              host.split(separator: ".").allSatisfy({ Int($0).map { (0...255).contains($0) } ?? false }),
              (host.hasPrefix("192.168.") || host.hasPrefix("10.") ||
               ((Int(host.split(separator: ".")[0]) == 172) &&
                (16...31).contains(Int(host.split(separator: ".")[1]) ?? 0))),
              components.user == nil, components.password == nil,
              components.path.isEmpty, components.query == nil, components.fragment == nil,
              let fingerprint = value["fingerprint"] as? String,
              fingerprint.count == 64, fingerprint.allSatisfy(\.isHexDigit),
              let token = value["token"] as? String,
              token.count == 64, token.allSatisfy(\.isHexDigit)
        else { return nil }
        return ["baseURL": baseURL, "fingerprint": fingerprint.uppercased(), "token": token.lowercased()]
    }
}

struct AlongWebView: UIViewRepresentable {
    @ObservedObject var bridge: AlongBridgeModel
    private let site = URL(string: "along://app/index.html?build=51")!

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge) }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "alongHealth")
        controller.add(context.coordinator, name: "alongHealthRefresh")
        controller.add(context.coordinator, name: "alongHealthClear")
        controller.add(context.coordinator, name: "alongAgent")
        controller.addUserScript(WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.setURLSchemeHandler(BundledWebSchemeHandler(), forURLScheme: "along")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.attach(webView)
        UNUserNotificationCenter.current().delegate = context.coordinator
        webView.navigationDelegate = context.coordinator
        let request = URLRequest(url: site, cachePolicy: .reloadIgnoringLocalCacheData)
#if DEBUG
        Task { @MainActor in
            await AlongConnectionStore.bootstrapFromEnvironment()
            webView.load(request)
        }
#else
        webView.load(request)
#endif
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static let bridgeScript = """
    (() => {
      // along:// 是自定义 scheme，不是安全上下文，crypto.randomUUID 可能不存在。
      // 这些 id 只用于本机把一次请求和一次结果对上，不需要密码学强度。
      const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2).padEnd(8,'0')}`);
      const pending = new Map();
      window.__alongHealthBridgeFinish = (id, result) => {
        const item = pending.get(id); if (!item) return;
        pending.delete(id);
        if (result.ok) item.resolve(result.snapshot);
        else item.reject(Object.assign(new Error(result.error || '导入已取消'), {code: result.code}));
      };
      window.AlongHealthBridge = {
        connect: ({types} = {}) => new Promise((resolve, reject) => {
          const id = newId();
          pending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongHealth.postMessage({id, types});
        }),
        refresh: () => new Promise((resolve, reject) => {
          const id = newId();
          pending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongHealthRefresh.postMessage({id});
        }),
        clear: () => new Promise((resolve, reject) => {
          const id = newId();
          pending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongHealthClear.postMessage({id});
        })
      };
      const agentPending = new Map();
      window.__alongAgentBridgeFinish = (id, result) => {
        const item = agentPending.get(id); if (!item) return;
        agentPending.delete(id);
        if (result.ok) item.resolve(result.value);
        else item.reject(new Error(result.error || 'Along 请求失败'));
      };
      window.AlongAgentBridge = {
        request: ({baseURL, fingerprint, path, token, body}) => new Promise((resolve, reject) => {
          const id = newId();
          agentPending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongAgent.postMessage({id, baseURL, fingerprint, path, token, body});
        }),
        connection: (action, value = null) => new Promise((resolve, reject) => {
          const id = newId();
          agentPending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongAgent.postMessage({id, operation: 'connection', action, value});
        }),
        notification: (action, value = null) => new Promise((resolve, reject) => {
          const id = newId();
          agentPending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongAgent.postMessage({id, operation: 'notification', action, value});
        })
      };
    })();
    """

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, UIGestureRecognizerDelegate, UNUserNotificationCenterDelegate {
        let bridge: AlongBridgeModel
        private weak var webView: WKWebView?
        private weak var edgeBackGesture: UIScreenEdgePanGestureRecognizer?
        private var pendingNotificationOpen: [String: String]?
        private var webReady = false

        init(bridge: AlongBridgeModel) {
            self.bridge = bridge
            super.init()
        }

        func attach(_ webView: WKWebView) {
            self.webView = webView
            if edgeBackGesture == nil {
                let gesture = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdgeBack(_:)))
                gesture.edges = .left
                gesture.cancelsTouchesInView = false
                gesture.delegate = self
                webView.addGestureRecognizer(gesture)
                edgeBackGesture = gesture
            }
            suppressKeyboardAssistant()
        }

        @objc private func handleEdgeBack(_ gesture: UIScreenEdgePanGestureRecognizer) {
            guard gesture.state == .ended, let webView else { return }
            let translation = gesture.translation(in: webView)
            let velocity = gesture.velocity(in: webView)
            guard translation.x >= 64, velocity.x > 0, abs(translation.y) < translation.x else { return }
            webView.evaluateJavaScript("window.__alongNavigateBack?.()")
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            true
        }

        private func suppressKeyboardAssistant() {
            guard let webView else { return }
            webView.removeFormInputAccessoryView()
            webView.clearInputAssistantButtons()
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = message.frameInfo.securityOrigin
            let trustedOrigin = (origin.protocol == "along" && origin.host == "app") ||
                                (origin.protocol == "https" && origin.host == "artstur.github.io")
            guard ["alongHealth", "alongHealthRefresh", "alongHealthClear", "alongAgent"].contains(message.name), message.frameInfo.isMainFrame,
                  trustedOrigin,
                  let body = message.body as? [String: Any], let id = body["id"] as? String,
                  let webView = message.webView else { return }
            if message.name == "alongHealth" {
                Task { @MainActor in bridge.begin(id: id, webView: webView) }
            } else if message.name == "alongHealthRefresh" {
                Task { @MainActor in bridge.refreshSnapshot(id: id, webView: webView) }
            } else if message.name == "alongHealthClear" {
                Task { @MainActor in bridge.clearHealth(id: id, webView: webView) }
            } else {
                if body["operation"] as? String == "notification" {
                    Task {
                        let result: [String: Any]
                        do { result = ["ok": true, "value": try await Self.notificationOperation(body)] }
                        catch { result = ["ok": false, "error": error.localizedDescription] }
                        await MainActor.run { Self.deliverAlongResult(id: id, result: result, webView: webView) }
                    }
                    return
                }
                if body["operation"] as? String == "connection" {
                    let result: [String: Any]
                    do { result = ["ok": true, "value": try Self.connectionOperation(body)] }
                    catch { result = ["ok": false, "error": error.localizedDescription] }
                    Self.deliverAlongResult(id: id, result: result, webView: webView)
                    return
                }
                Task {
                    let result: [String: Any]
                    do { result = ["ok": true, "value": try await Self.agentRequest(body)] }
                    catch { result = ["ok": false, "error": error.localizedDescription] }
                    await MainActor.run { Self.deliverAlongResult(id: id, result: result, webView: webView) }
                }
            }
        }

        static func connectionOperation(_ input: [String: Any]) throws -> [String: String] {
            switch input["action"] as? String {
            case "load":
                let saved = AlongConnectionStore.load()
                print("Along connection delivered to web: \(saved != nil)")
                return saved ?? [:]
            case "save":
                guard let value = input["value"] as? [String: Any],
                      let saved = AlongConnectionStore.save(value) else { throw AgentBridgeError.invalidConfiguration }
                return saved
            default: throw AgentBridgeError.invalidConfiguration
            }
        }

        static func notificationOperation(_ input: [String: Any]) async throws -> [String: Any] {
            let center = UNUserNotificationCenter.current()
            switch input["action"] as? String {
            case "enable":
                let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                return ["status": granted ? "authorized" : "denied"]
            case "status":
                let settings = await center.notificationSettings()
                return ["status": notificationStatus(settings.authorizationStatus)]
            case "replaceHealthReminders":
                guard let value = input["value"] as? [String: Any],
                      let items = value["items"] as? [[String: Any]], items.count <= 6
                else { throw AgentBridgeError.server("健康提醒列表无效") }
                let goalKey = value["goalKey"] as? String ?? "health"
                guard goalKey == "health" || (goalKey.hasPrefix("custom:") && (8...100).contains(goalKey.count))
                else { throw AgentBridgeError.server("健康提醒的目标无效") }
                return try await enqueueHealthReminderReplacement(items, goalKey: goalKey, center: center)
            case "notify":
                var status = await center.notificationSettings().authorizationStatus
                if status == .notDetermined {
                    let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                    status = granted ? .authorized : .denied
                }
                guard [.authorized, .provisional, .ephemeral].contains(status),
                      let value = input["value"] as? [String: Any],
                      let rawID = value["id"] as? String, !rawID.isEmpty,
                      let rawTitle = value["title"] as? String, !rawTitle.isEmpty,
                      let rawBody = value["body"] as? String, !rawBody.isEmpty,
                      let kind = value["kind"] as? String, ["goal", "task"].contains(kind),
                      let goalKey = value["goalKey"] as? String, !goalKey.isEmpty
                else { throw AgentBridgeError.notificationUnavailable }
                let content = UNMutableNotificationContent()
                content.title = String(rawTitle.prefix(80))
                content.body = String(rawBody.prefix(180))
                content.sound = .default
                content.threadIdentifier = "along.agent.action"
                var userInfo = ["kind": kind, "goalKey": String(goalKey.prefix(100))]
                if let taskID = value["taskId"] as? String { userInfo["taskId"] = String(taskID.prefix(64)) }
                if let requestID = value["requestId"] as? String { userInfo["requestId"] = String(requestID.prefix(160)) }
                content.userInfo = userInfo
                let identifier = "along.agent.\(Self.notificationIdentifier(rawID))"
                let request = UNNotificationRequest(identifier: identifier, content: content,
                                                    trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false))
                try await center.add(request)
                return ["status": "scheduled", "scheduled": true]
            default:
                throw AgentBridgeError.invalidConfiguration
            }
        }

        private static func notificationStatus(_ status: UNAuthorizationStatus) -> String {
            switch status {
            case .authorized: "authorized"
            case .provisional: "provisional"
            case .ephemeral: "ephemeral"
            case .denied: "denied"
            case .notDetermined: "notDetermined"
            @unknown default: "unknown"
            }
        }

        private static func notificationIdentifier(_ value: String) -> String {
            let digest = SHA256.hash(data: Data(value.utf8))
            return digest.map { String(format: "%02x", $0) }.joined()
        }

        private static func healthReminderPrefix(_ goalKey: String) -> String {
            // Old installations already have reminders under this exact prefix.
            if goalKey == "health" { return "along.health-plan." }
            return "along.custom-health-plan." + notificationIdentifier(goalKey) + "."
        }

        // A new plan can be adopted or cleared while the OS is still adding
        // requests for the preceding plan. Apply entire batches in call order.
        @MainActor private static var lastReminderReplacement: Task<Void, Never>?

        @MainActor private static func enqueueHealthReminderReplacement(_ items: [[String: Any]], goalKey: String,
                    center: UNUserNotificationCenter) async throws -> [String: Any] {
            let previous = lastReminderReplacement
            let work = Task {
                await previous?.value
                return try await replaceHealthReminders(items, goalKey: goalKey, center: center)
            }
            lastReminderReplacement = Task { _ = try? await work.value }
            return try await work.value
        }

        private static func replaceHealthReminders(_ items: [[String: Any]], goalKey: String, center: UNUserNotificationCenter) async throws -> [String: Any] {
            let prefix = healthReminderPrefix(goalKey)
            var desired: [UNNotificationRequest] = []
            var identifiers = Set<String>()
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(secondsFromGMT: 0)!
            let parser = ISO8601DateFormatter()
            let fractionalParser = ISO8601DateFormatter()
            fractionalParser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            for item in items {
                guard let id = item["id"] as? String, !id.isEmpty, id.count <= 160,
                      let title = item["title"] as? String, !title.isEmpty,
                      let body = item["body"] as? String, !body.isEmpty,
                      let taskID = item["taskId"] as? String, !taskID.isEmpty, taskID.count <= 64,
                      let requestID = item["requestId"] as? String, !requestID.isEmpty, requestID.count <= 160,
                      let raw = item["scheduledFor"] as? String,
                      raw.range(of: #"(Z|[+-][0-9]{2}:[0-9]{2})$"#, options: .regularExpression) != nil,
                      let date = parser.date(from: raw) ?? fractionalParser.date(from: raw), date > Date()
                else { throw AgentBridgeError.server("健康提醒缺少任务信息或有效的未来时间") }
                let identifier = prefix + notificationIdentifier(id)
                guard identifiers.insert(identifier).inserted else { throw AgentBridgeError.server("健康提醒重复") }
                let content = UNMutableNotificationContent()
                content.title = String(title.prefix(80))
                content.body = String(body.prefix(180))
                content.sound = .default
                content.threadIdentifier = "along.agent.action"
                content.userInfo = ["kind": "task", "goalKey": goalKey, "taskId": taskID, "requestId": requestID]
                let components = calendar.dateComponents([.calendar, .timeZone, .year, .month, .day, .hour, .minute, .second], from: date)
                desired.append(UNNotificationRequest(identifier: identifier, content: content,
                    trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)))
            }
            let old = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(prefix) }
            let permission = await center.notificationSettings().authorizationStatus
            let permitted = [.authorized, .provisional, .ephemeral].contains(permission)
            if desired.isEmpty || !permitted {
                center.removePendingNotificationRequests(withIdentifiers: old.map(\.identifier))
                let remaining = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(prefix) }.count
                guard remaining == 0 else { throw AgentBridgeError.server("系统仍保留部分旧健康提醒，请稍后重试") }
                return ["status": desired.isEmpty ? "cleared" : notificationStatus(permission), "scheduledCount": 0]
            }
            var added: [String] = []
            do {
                for request in desired {
                    try await center.add(request)
                    added.append(request.identifier)
                }
            } catch {
                // Restore the previous pending set if an individual add fails.
                center.removePendingNotificationRequests(withIdentifiers: added)
                for prior in old where added.contains(prior.identifier) {
                    if let trigger = prior.trigger as? UNCalendarNotificationTrigger,
                       let date = trigger.nextTriggerDate(), date > Date() {
                        try await center.add(prior)
                    }
                }
                throw error
            }
            center.removePendingNotificationRequests(withIdentifiers: old.map(\.identifier).filter { !identifiers.contains($0) })
            let pending = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(prefix) }
            guard Set(pending.map(\.identifier)) == identifiers else {
                throw AgentBridgeError.server("系统中的健康提醒与当前安排不一致，请稍后重试")
            }
            return ["status": "scheduled", "scheduledCount": pending.count]
        }

        func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
            completionHandler([.banner, .list, .sound])
        }

        func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                    withCompletionHandler completionHandler: @escaping () -> Void) {
            let info = response.notification.request.content.userInfo
            var payload: [String: String] = [:]
            for key in ["kind", "goalKey", "taskId", "requestId"] {
                if let value = info[key] as? String { payload[key] = value }
            }
            DispatchQueue.main.async {
                self.openNotification(payload)
                completionHandler()
            }
        }

        private func openNotification(_ payload: [String: String]) {
            guard !payload.isEmpty else { return }
            guard webReady, let webView,
                  let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else {
                pendingNotificationOpen = payload
                return
            }
            webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('along-notification-open', {detail: \(json)}))")
            pendingNotificationOpen = nil
        }

        static func deliverAlongResult(id: String, result: [String: Any], webView: WKWebView) {
            guard let data = try? JSONSerialization.data(withJSONObject: [id, result]),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window.__alongAgentBridgeFinish(...\(json))")
        }

        static func agentRequest(_ input: [String: Any]) async throws -> [String: Any] {
            guard let base = input["baseURL"] as? String, let components = URLComponents(string: base),
                  components.scheme == "https", let host = components.host,
                  host.split(separator: ".").count == 4,
                  host.split(separator: ".").allSatisfy({ Int($0).map { (0...255).contains($0) } ?? false }),
                  (host.hasPrefix("192.168.") || host.hasPrefix("10.") ||
                   ((Int(host.split(separator: ".")[0]) == 172) &&
                    (16...31).contains(Int(host.split(separator: ".")[1]) ?? 0))),
                  components.user == nil, components.password == nil,
                  components.path.isEmpty, components.query == nil, components.fragment == nil,
                  let fingerprint = input["fingerprint"] as? String,
                  fingerprint.count == 64, fingerprint.allSatisfy(\.isHexDigit),
                  let path = input["path"] as? String,
                  ["/pair", "/connection/verify", "/connection/status", "/goal/event", "/super-agent/tasks", "/super-agent/tasks/status",
                   "/super-agent/goals", "/super-agent/goals/status"].contains(path),
                  let body = input["body"] as? [String: Any],
                  let url = URL(string: base + path) else { throw AgentBridgeError.invalidConfiguration }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = path == "/connection/verify" ? 12 : 120
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let token = input["token"] as? String, !token.isEmpty {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let delegate = PinnedAgentDelegate(fingerprint: fingerprint.uppercased())
            let configuration = URLSessionConfiguration.ephemeral
            configuration.waitsForConnectivity = true
            configuration.timeoutIntervalForResource = path == "/connection/verify" ? 15 : 120
            // Every session is tied to one private address, pinned certificate and non-redirecting request.
            configuration.connectionProxyDictionary = [
                kCFNetworkProxiesProxyAutoConfigEnable as String: true,
                kCFNetworkProxiesProxyAutoConfigJavaScript as String: "function FindProxyForURL(url, host) { return 'DIRECT' }"
            ]
            let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
            defer { session.finishTasksAndInvalidate() }
            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await session.data(for: request)
            } catch {
                print("Along agent request failed: \(error.localizedDescription)")
                if let message = AgentBridgeError.transportMessage(error) { throw AgentBridgeError.server(message) }
                throw error
            }
            guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AgentBridgeError.invalidResponse }
            guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode) else {
                throw AgentBridgeError.server(result["error"] as? String ?? "Along 请求失败")
            }
            return result
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            print("Along web view loaded: \(webView.url?.absoluteString ?? "unknown")")
            suppressKeyboardAssistant()
#if DEBUG
            if ProcessInfo.processInfo.environment["ALONG_OPEN_AGENT"] == "1" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    webView.evaluateJavaScript("document.querySelector('[data-action=edit-goal]')?.click()")
                }
            }
#endif
            bridge.webLoading = false
            bridge.webError = nil
            webReady = true
            Task { @MainActor in bridge.attach(webView) }
            if let pendingNotificationOpen { openNotification(pendingNotificationOpen) }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            webReady = false
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) {
            print("Along provisional navigation failed: \(error.localizedDescription)")
            webReady = false
            bridge.webLoading = false
            bridge.webError = error.localizedDescription
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("Along navigation failed: \(error.localizedDescription)")
            webReady = false
            bridge.webLoading = false
            bridge.webError = error.localizedDescription
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            print("Along web content process terminated")
            bridge.webLoading = false
            bridge.webError = "页面进程意外退出，请重新打开 App"
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if url.scheme == "https", ["duolingo.com", "www.duolingo.com"].contains(url.host ?? "") {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            let trustedRemote = url.scheme == "https" && url.host == "artstur.github.io" &&
                                url.path.hasPrefix("/Personality-Demo/")
            let trustedBundled = url.scheme == "along" && url.host == "app"
            decisionHandler(trustedBundled || trustedRemote ? .allow : .cancel)
        }
    }
}

private extension UIView {
    func clearInputAssistantButtons() {
        inputAssistantItem.leadingBarButtonGroups = []
        inputAssistantItem.trailingBarButtonGroups = []
        subviews.forEach { $0.clearInputAssistantButtons() }
    }
}

private extension WKWebView {
    func removeFormInputAccessoryView() {
        guard let contentView = descendant(where: {
            NSStringFromClass(type(of: $0)).contains("WKContentView")
        }), let originalClass = object_getClass(contentView) else { return }

        let currentName = NSStringFromClass(originalClass)
        if currentName.hasPrefix("AlongAccessoryFree_") { return }

        let safeName = currentName.replacingOccurrences(of: ".", with: "_")
        let subclassName = "AlongAccessoryFree_\(safeName)"
        let accessoryFreeClass: AnyClass
        if let existing = NSClassFromString(subclassName) {
            accessoryFreeClass = existing
        } else {
            guard let created = objc_allocateClassPair(originalClass, subclassName, 0) else { return }
            let selector = #selector(getter: UIResponder.inputAccessoryView)
            let block: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            let implementation = imp_implementationWithBlock(block)
            guard let method = class_getInstanceMethod(UIResponder.self, selector) else {
                objc_disposeClassPair(created)
                return
            }
            class_addMethod(created, selector, implementation, method_getTypeEncoding(method))
            objc_registerClassPair(created)
            accessoryFreeClass = created
        }
        object_setClass(contentView, accessoryFreeClass)
    }

    func descendant(where predicate: (UIView) -> Bool) -> UIView? {
        var queue = subviews
        while !queue.isEmpty {
            let view = queue.removeFirst()
            if predicate(view) { return view }
            queue.append(contentsOf: view.subviews)
        }
        return nil
    }
}

final class BundledWebSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url,
              requestURL.scheme == "along", requestURL.host == "app" else {
            urlSchemeTask.didFailWithError(URLError(.badURL)); return
        }
        let requested = requestURL.path.removingPercentEncoding ?? requestURL.path
        let relativePath = requested == "/" ? "index.html" : String(requested.dropFirst())
        guard !relativePath.contains(".."),
              let fileURL = Bundle.main.url(forResource: relativePath, withExtension: nil, subdirectory: "Web"),
              let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let ext = fileURL.pathExtension.lowercased()
        let mimeType: String = switch ext {
        case "html": "text/html"
        case "css": "text/css"
        case "mjs", "js": "text/javascript"
        case "json": "application/json"
        case "webmanifest": "application/manifest+json"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        default: "application/octet-stream"
        }
        let encoding = ["html", "css", "mjs", "js", "json", "webmanifest", "svg"].contains(ext) ? "utf-8" : nil
        let response = URLResponse(url: requestURL, mimeType: mimeType,
                                   expectedContentLength: data.count, textEncodingName: encoding)
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

enum AgentBridgeError: LocalizedError {
    case invalidConfiguration, invalidResponse, notificationUnavailable, server(String)

    static func transportMessage(_ error: Error) -> String? {
        let cause = error as NSError
        let underlying = cause.userInfo[NSUnderlyingErrorKey] as? NSError
        let networkErrors = [cause, underlying].compactMap { $0 }.filter {
            $0.domain == NSURLErrorDomain || $0.domain == kCFErrorDomainCFNetwork as String
        }
        if networkErrors.contains(where: { $0.code == CFNetworkErrors.cfErrorHTTPSProxyConnectionFailure.rawValue }) {
            return "代理未能连接到 Mac。请确认当前代理或 VPN 允许 Along 直连局域网，再重试评估。"
        }
        let codes = networkErrors.map { URLError.Code(rawValue: $0.code) }
        if codes.contains(where: { [.secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted,
                                    .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid].contains($0) }) {
            return "iPhone 未能验证 Mac 的安全连接。若使用代理或 VPN，请允许 Along 直连局域网后重试。"
        }
        if codes.contains(where: { [.timedOut, .cannotConnectToHost, .notConnectedToInternet, .networkConnectionLost].contains($0) }) {
            return "连接 Mac 失败。请让 iPhone 和 Mac 接入可互访的网络，并确认 Mac 上的 Along 服务正在运行。若 Mac 地址变了，请到「编辑目标」更新地址后重试。"
        }
        return nil
    }

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: "Along 连接信息不正确"
        case .invalidResponse: "Along 返回格式不正确"
        case .notificationUnavailable: "请在系统设置中允许 Along 通知"
        case .server(let message): message
        }
    }
}

final class PinnedAgentDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    private let fingerprint: String
    init(fingerprint: String) { self.fingerprint = fingerprint }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let certificate = SecTrustGetCertificateAtIndex(trust, 0) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        let digest = SHA256.hash(data: SecCertificateCopyData(certificate) as Data)
            .map { String(format: "%02X", $0) }.joined()
        if digest != fingerprint { print("Along certificate pin mismatch") }
        completionHandler(digest == fingerprint ? .useCredential : .cancelAuthenticationChallenge,
                          digest == fingerprint ? URLCredential(trust: trust) : nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct HealthSyncSheet: View {
    @ObservedObject var bridge: AlongBridgeModel

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(HealthMetric.allCases) { metric in
                        Toggle(isOn: Binding(
                            get: { bridge.selection.contains(metric) },
                            set: { enabled in
                                if enabled { bridge.selection.insert(metric) }
                                else { bridge.selection.remove(metric) }
                                bridge.preview = nil
                            }
                        )) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(metric.title)
                                Text(metric.period).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .disabled(bridge.busy)
                    }
                    Button(bridge.busy ? "正在读取…" : "读取并预览") { bridge.readPreview() }
                        .disabled(bridge.selection.isEmpty || bridge.busy)
                } header: {
                    Text("选择要读取的数据 · 已选 \(bridge.selection.count)/\(HealthMetric.allCases.count)")
                } footer: {
                    Text("已选项目会在 App 前台自动检查。开关表示 Along 的选择；HealthKit 不会向 App 告知某项读取权限是否已被拒绝。")
                }
                Section("睡眠评分") {
                    Text("Apple 睡眠评分目前没有可供第三方 App 直接读取的 HealthKit 类型。Along 可读取昨晚睡眠时长，但不会把它伪装成苹果评分。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let preview = bridge.preview {
                    Section("导入前预览") {
                        ForEach(preview.selected) { metric in
                            LabeledContent(metric.title, value: preview.displayValue(for: metric))
                        }
                        Text("睡眠摘要包含最近一夜的首末睡眠记录时间。运动摘要包含按运动类型、星期和小时分组的次数与时长。空值表示当前读不到记录。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section("导入 Along") {
                        Text("确认后，Along 导入你所选的摘要。连接 Mac 时，Super Agent 可在数据变化或到达复查时间时，结合当前目标与已有安排评估是否调整。")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("导入并允许 Agent 评估") { bridge.confirmImport() }
                            .disabled(bridge.busy || !preview.hasReadableValue)
                    }
                }
                if let error = bridge.errorMessage {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("连接 Apple Health")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { bridge.cancel() }.disabled(bridge.busy)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("全部连接") { bridge.selectAll() }
                        .disabled(bridge.busy || bridge.selection.count == HealthMetric.allCases.count)
                }
            }
        }
    }
}
