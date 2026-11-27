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
    @UIApplicationDelegateAdaptor(HealthDeliveryAppDelegate.self) private var healthDelegate
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
                .sheet(item: $bridge.okxConnection, onDismiss: { bridge.finishOkx() }) { connection in
                    OKXConnectionSheet(goalID: connection.goalID, onClose: { bridge.okxConnection = nil })
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { bridge.resumeForeground() }
                    if phase == .background { bridge.pauseForeground() }
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
    struct OkxPresentation: Identifiable { let id = UUID(); let goalID: String }
    @Published var okxConnection: OkxPresentation?
    private var okxRequest: (id: String, goalID: String, view: WKWebView)?

    @Published var showSheet = false
    @Published var selection: Set<HealthMetric> = []
    @Published var preview: HealthSummary?
    @Published var busy = false
    @Published var errorMessage: String?
    @Published var webLoading = true
    @Published var webError: String?

    @Published private(set) var backgroundSelected = false
    private(set) var managedGoal: String?
    var foregroundReadsAllowed: () -> Bool = { true }
    var backgroundConsentChanged: () -> Void = {}
    var requestHealthEventSync: () -> Void = {}
    private let backgroundPreference = "along.health.backgroundReviewGoal.v1"

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
        if foregroundReadsAllowed() { resumeForeground() }
    }

    func resumeForeground() { startObservers(); refreshHealth(); requestHealthEventSync(); PhoneSourceCoordinator.shared.resumeForeground() }
    func pauseForeground() { reader.stopObserving() }

    private var savedSelection: Set<HealthMetric> {
        Set((UserDefaults.standard.stringArray(forKey: "along.health.selectedTypes") ?? []).compactMap(HealthMetric.init(rawValue:)))
    }

    private var contextReviewAllowed: Bool {
        UserDefaults.standard.bool(forKey: "along.health.contextReview.v1")
    }

    private var comparisonHistoryAllowed: Bool {
        UserDefaults.standard.bool(forKey: "along.health.comparisonHistory.v1")
    }

    private func startObservers() {
        let selected = savedSelection
        guard !selected.isEmpty else { return }
        reader.observe(selected) { [weak self] in
            Task { @MainActor in if self?.foregroundReadsAllowed() == true { self?.refreshHealth() } }
        }
    }

    func refreshHealth() {
        guard foregroundReadsAllowed(), !savedSelection.isEmpty else { return }
        healthUpdateRequested = true
        startHealthRefresh()
    }

    func refreshSnapshot(id: String, webView: WKWebView) {
        guard foregroundReadsAllowed() else {
            deliver(id: id, result: ["ok": false, "error": "回到前台后重新读取健康摘要"], to: webView)
            return
        }
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
                    let summary = try await reader.read(savedSelection, requestPermission: false, includeContext: contextReviewAllowed,
                                                        includeComparisonHistory: comparisonHistoryAllowed)
                    let snapshot = scopedSnapshot(summary)
                    if publish && epoch == healthEpoch && foregroundReadsAllowed() { publishHealthSnapshot(snapshot); requestHealthEventSync() }
                    result = ["ok": true, "snapshot": snapshot]
                } catch {
                    if publish && epoch == healthEpoch { errorMessage = error.localizedDescription }
                    result = ["ok": false, "error": error.localizedDescription]
                }
                if !foregroundReadsAllowed() { result = ["ok": false, "error": "回到前台后重新读取健康摘要"] }
                if epoch != healthEpoch { result = ["ok": false, "error": "健康数据选择已更新"] }
                for request in requests { deliver(id: request.id, result: result, to: request.view) }
            }
        }
    }

    private func scopedSnapshot(_ summary: HealthSummary) -> [String: Any] {
        var snapshot = summary.browserSnapshot(contextReviewAllowed: contextReviewAllowed, comparisonHistoryAllowed: comparisonHistoryAllowed)
        let goal = contextReviewAllowed ? UserDefaults.standard.string(forKey: backgroundPreference) : nil
        snapshot["backgroundReviewAllowed"] = goal != nil
        snapshot["backgroundReviewGoalKey"] = goal as Any? ?? NSNull()
        return snapshot
    }

    func chooseBackground(_ enabled: Bool) {
        guard let managedGoal else { return }
        backgroundSelected = enabled
        // Existing imports can change just background delivery without reading more types or enabling longer history.
        if contextReviewAllowed && !savedSelection.isEmpty {
            persistBackgroundChoice(goal: managedGoal)
            backgroundConsentChanged()
            refreshHealth()
        }
    }

    private func persistBackgroundChoice(goal: String) {
        if backgroundSelected { UserDefaults.standard.set(goal, forKey: backgroundPreference) }
        else if UserDefaults.standard.string(forKey: backgroundPreference) == goal {
            UserDefaults.standard.removeObject(forKey: backgroundPreference)
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
        UserDefaults.standard.removeObject(forKey: "along.health.comparisonHistory.v1")
        UserDefaults.standard.removeObject(forKey: backgroundPreference)
        backgroundSelected = false
        backgroundConsentChanged()
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

    func begin(id: String, webView: WKWebView, goalKey: String? = nil) {
        // 在途导入已经有一个请求时，这次要明确答复，不能直接丢掉。
        if let refusal = HealthImportAdmission.refusal(pending: requestID) {
            deliver(id: id, result: refusal, to: webView)
            return
        }
        managedGoal = goalKey.flatMap { key in
            key == "health" || (key.hasPrefix("custom:") && (8...100).contains(key.count)) ? key : nil
        }
        backgroundSelected = managedGoal != nil && UserDefaults.standard.string(forKey: backgroundPreference) == managedGoal
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
                let summary = try await reader.read(selected, includeComparisonHistory: true)
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
        UserDefaults.standard.set(true, forKey: "along.health.comparisonHistory.v1")
        if let managedGoal { persistBackgroundChoice(goal: managedGoal) }
        backgroundConsentChanged()
        startObservers()
        finish(snapshot: scopedSnapshot(preview))
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
    private(set) static var saveRevision: UInt64 = 0
    private static let legacyKey = "along.connection.v1"
    private static let service = "com.artstur.AlongHealth.connection"
    private static let account = "Along"

    // 信任策略（docs/iphone-ca-profile-design.md §2.2）：
    //   system-pki-v1     —— 云端 DNS 或公网 IPv4。证书由 iOS 系统信任评估，App 不比叶指纹。
    //   legacy-local-pin-v1 —— Mac 私网 RFC1918 连接。保留原来的叶指纹钉扎，行为不变。
    // 这不是用户可选的模式开关：策略由主机形态（私网 IPv4、DNS 域名或公网 IPv4）推导后写进持久状态。
    static let systemTrustPolicy = "system-pki-v1"
    static let legacyPinPolicy = "legacy-local-pin-v1"

    // 稳定的绑定作用域 ID（docs/iphone-ca-profile-design.md §2.2「bindingScopeId」）：
    // 由规范化 origin（scheme/host/有效端口）与配对 token 的哈希派生，不随叶证书轮换改变，
    // 因此换叶证书不会被误判成换用户或换设备。它不是凭证，也不发给模型。
    static func bindingScopeId(baseURL: String, token: String) -> String? {
        guard let components = URLComponents(string: baseURL),
              components.scheme == "https", let host = components.host,
              token.count == 64 else { return nil }
        // 有效端口：显式端口优先，缺省按 scheme 取默认端口。origin 必须规范化，
        // 否则同一台服务器的两种写法会算出两个作用域 ID。
        let port = components.port ?? (components.scheme == "https" ? 443 : nil)
        guard let port else { return nil }
        let origin = "\(components.scheme!)://\(host.lowercased()):\(port)"
        return SHA256.hash(data: Data([origin, token.lowercased()].joined(separator: "\n").utf8))
            .map { String(format: "%02x", $0) }.joined()
    }

    // 连接形态判定：RFC1918 私网 IPv4 走旧 pin，其余已允许的云端主机走系统信任评估。
    // 不新增用户可选开关，也不接受 JavaScript 自报 trustPolicy 来放宽规则。
    static func trustPolicy(forHost host: String) -> String {
        isPrivateIPv4(host) ? legacyPinPolicy : systemTrustPolicy
    }

    // 旧 pin 形态下取叶指纹；系统信任形态返回 nil（叶指纹不再是信任依据）。
    // 格式不合法一律返回 nil，由调用方按「没有可用 pin」处理。
    static func pinnedFingerprint(_ value: String?, policy: String) -> String? {
        guard policy == legacyPinPolicy, let pin = value, pin.count == 64, pin.allSatisfy(\.isHexDigit) else { return nil }
        return pin.uppercased()
    }

    // Reusing this Mac's bearer at another endpoint must retain the original
    // local pin policy and certificate. Run before creating/sending any request,
    // including the Web/DEBUG address form's earlier /connection/verify call.
    static func permitsPairedTransport(_ input: [String: Any]) -> Bool {
        guard let current = load(), let base = current["baseURL"],
              let oldHost = URLComponents(string: base)?.host,
              let token = input["token"] as? String,
              token.lowercased() == current["token"]?.lowercased() else { return true }
        guard let nextBase = input["baseURL"] as? String,
              let host = URLComponents(string: nextBase)?.host else { return false }
        if trustPolicy(forHost: oldHost) == legacyPinPolicy {
            guard trustPolicy(forHost: host) == legacyPinPolicy,
                  let pin = input["fingerprint"] as? String,
                  pin.uppercased() == current["fingerprint"]?.uppercased() else { return false }
            return true
        }
        // A public CA authenticates only its own origin. Reusing an existing
        // PKI bearer across origins requires a new pairing, even with no pins.
        guard let oldScope = bindingScopeId(baseURL: base, token: token),
              let nextScope = bindingScopeId(baseURL: nextBase, token: token) else { return false }
        return oldScope == nextScope
    }

    // 入口守卫用：系统信任形态一律放行（不需要叶指纹）；旧 pin 形态必须带合法 64hex。
    static func acceptsPin(_ value: String?, policy: String) -> Bool {
        policy == systemTrustPolicy || pinnedFingerprint(value, policy: policy) != nil
    }

    static func isPrivateIPv4(_ host: String) -> Bool {
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count == 4,
              labels.allSatisfy({ Int($0).map { (0...255).contains($0) } ?? false }),
              host.hasPrefix("192.168.") || host.hasPrefix("10.") ||
              ((Int(labels[0]) == 172) && (16...31).contains(Int(labels[1]) ?? 0))
        else { return false }
        return true
    }

    // 统一的「作用域种子」：所有用叶指纹做作用域的地方改用它
    // （docs/iphone-ca-profile-design.md §2.2「一起迁移；不能只修改一个网络委托」）。
    //   - 旧 pin 形态：保持原来的 base|fingerprint|token 三段，作用域值与迁移前完全一致；
    //   - 系统信任形态：改用 bindingScopeId（origin + token 派生），叶证书轮换不改变作用域。
    static func scopeSeed(_ connection: [String: String]) -> String? {
        guard let base = connection["baseURL"], let token = connection["token"] else { return nil }
        let policy = connection["trustPolicy"] ?? legacyPinPolicy
        if policy == legacyPinPolicy {
            guard let pin = connection["fingerprint"], pin.count == 64 else { return nil }
            return [base, pin, token].joined(separator: "\n")
        }
        guard let scope = connection["bindingScopeId"] ?? bindingScopeId(baseURL: base, token: token) else { return nil }
        return scope
    }

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
        saveRevision &+= 1
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
                  result["paired"] as? Bool == true, load() == saved else {
                print("Along host migration could not verify or persist the pairing")
                return
            }
            do { _ = try await HealthEventDelivery.shared.saveConnection(next) }
            catch {
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
        _ = try? await HealthEventDelivery.shared.saveConnection(value)
    }
#endif

    // 公网 IPv4 使用十进制标准写法。保留 RFC1918 的既有校验，
    // 特殊用途地址不进入公网系统信任路径。
    static func hostAccepted(_ host: String) -> Bool {
        if isPrivateIPv4(host) { return true }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        if labels.count == 4, labels.allSatisfy({ !$0.isEmpty && $0.utf8.allSatisfy { (48...57).contains($0) } }) {
            let octets = labels.compactMap { label -> Int? in
                guard let number = Int(label), (0...255).contains(number), String(number) == label else { return nil }
                return number
            }
            guard octets.count == 4 else { return false }
            switch (octets[0], octets[1], octets[2], octets[3]) {
            case (192, 0, 0, 9...10): // IANA 标记为全球可达的两项协议任播地址。
                return true
            case (0, _, _, _), (100, 64...127, _, _), (127, _, _, _), (169, 254, _, _),
                 (192, 0, 0, _), (192, 0, 2, _), (192, 88, 99, _), (198, 18...19, _, _),
                 (198, 51, 100, _), (203, 0, 113, _), (224...255, _, _, _):
                return false
            default:
                return true
            }
        }
        guard labels.count >= 2, host.count <= 253 else { return false }
        for label in labels {
            if label.isEmpty || label.count > 63 || label.first == "-" || label.last == "-" { return false }
            if !label.allSatisfy({ c in ("a"..."z").contains(c) || ("A"..."Z").contains(c) || ("0"..."9").contains(c) || c == "-" }) { return false }
        }
        let last = labels.last!
        // 防止 URL 栈把末段为十六进制的数字别名当作 IP。
        if last.lowercased().hasPrefix("0x"), last.dropFirst(2).allSatisfy(\.isHexDigit) { return false }
        return last.contains { c in ("a"..."z").contains(c) || ("A"..."Z").contains(c) }
    }

    static func clean(_ value: [String: Any]) -> [String: String]? {
        guard let baseURL = value["baseURL"] as? String,
              let components = URLComponents(string: baseURL),
              components.scheme == "https", let host = components.host,
              hostAccepted(host),
              components.user == nil, components.password == nil,
              components.path.isEmpty, components.query == nil, components.fragment == nil,
              let token = value["token"] as? String,
              token.count == 64, token.allSatisfy(\.isHexDigit)
        else { return nil }
        // 信任策略由主机形态推导，不接受调用方自报：云端 DNS 与公网 IPv4 走系统信任评估，
        // 私网 IPv4 保留旧叶指纹钉扎（docs/iphone-ca-profile-design.md §2.2）。
        let policy = trustPolicy(forHost: host)
        var clean = ["baseURL": baseURL, "trustPolicy": policy, "token": token.lowercased()]
        // 系统信任策略下叶指纹不是信任依据，也不再充当用户/设备绑定 ID；
        // 只有旧 pin 形态仍需保留它。
        if policy == legacyPinPolicy {
            guard let fingerprint = value["fingerprint"] as? String,
                  fingerprint.count == 64, fingerprint.allSatisfy(\.isHexDigit) else { return nil }
            clean["fingerprint"] = fingerprint.uppercased()
        }
        if let scope = bindingScopeId(baseURL: baseURL, token: token) {
            clean["bindingScopeId"] = scope
        }
        if value["runtime"] as? String == "dsh-superagent" {
            clean["runtime"] = "dsh-superagent"
        }
        return clean
    }
}

struct AlongWebView: UIViewRepresentable {
    @ObservedObject var bridge: AlongBridgeModel
    private let site = URL(string: "along://app/index.html?build=102")!

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge) }

    func makeUIView(context: Context) -> WKWebView {
        bridge.foregroundReadsAllowed = { UIApplication.shared.applicationState != .background }
        bridge.requestHealthEventSync = { HealthEventDelivery.shared.request() }
        bridge.backgroundConsentChanged = { BackgroundHealthReviews.shared.consentChanged(); HealthEventDelivery.shared.consentChanged() }
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
        webView.scrollView.bounces = false
        context.coordinator.attach(webView)
        EventTaskNotifications.shared.attach(context.coordinator)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        let request = URLRequest(url: site, cachePolicy: .reloadIgnoringLocalCacheData)
        Task { @MainActor in
            try? await HealthEventDelivery.shared.recoverWorkspaceHandoff(onlyIfAlreadyTarget: true)
#if DEBUG
            await AlongConnectionStore.bootstrapFromEnvironment()
            await Coordinator.processWorkspaceHandoffRequest()
#endif
            webView.load(request)
            let before = AlongConnectionStore.load()
            do {
                try await HealthEventDelivery.shared.recoverWorkspaceHandoff()
                if AlongConnectionStore.load() != before {
                    _ = try? await webView.evaluateJavaScript("window.dispatchEvent(new Event('along-native-connection-update'))")
                }
            } catch { /* Original cache remains usable; the authenticated journal retries next launch. */ }
        }
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
        connect: ({types, goalKey} = {}) => new Promise((resolve, reject) => {
          const id = newId();
          pending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongHealth.postMessage({id, types, goalKey});
        }),
        healthEvents: () => new Promise((resolve, reject) => {
          const id = newId(); agentPending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongAgent.postMessage({id, operation: 'healthEvents'});
        }),
        backgroundReview: (action, value = {}) => new Promise((resolve, reject) => {
          const id = newId();
          agentPending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongAgent.postMessage({id, operation: 'backgroundReview', action, value});
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
        else item.reject(Object.assign(new Error(result.error || 'Along 请求失败'), result.receipt ? {receipt: result.receipt} : {}));
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
        source: (action, goalId) => new Promise((resolve, reject) => {
          const id = newId();
          agentPending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongAgent.postMessage({id, operation: 'source', action, goalId});
        }),
        dailyReminderStatus: value => window.AlongAgentBridge.notification('dailyReminderStatus', value),
        pendingGoalReminder: goalKey => window.AlongAgentBridge.notification('upcomingGoalReminder', {goalKey}),
        notification: (action, value = null) => new Promise((resolve, reject) => {
          const id = newId();
          agentPending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongAgent.postMessage({id, operation: 'notification', action, value});
        })
      };
    })();
    """

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, UIGestureRecognizerDelegate, UNUserNotificationCenterDelegate {
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
                Task { @MainActor in bridge.begin(id: id, webView: webView, goalKey: origin.protocol == "along" ? body["goalKey"] as? String : nil) }
            } else if message.name == "alongHealthRefresh" {
                Task { @MainActor in bridge.refreshSnapshot(id: id, webView: webView) }
            } else if message.name == "alongHealthClear" {
                Task { @MainActor in bridge.clearHealth(id: id, webView: webView) }
            } else {
                if body["operation"] as? String == "source" {
                    guard origin.protocol == "along", origin.host == "app",
                          let goalID = body["goalId"] as? String,
                          goalID.range(of: #"^g_[A-Za-z0-9_-]{1,100}$"#, options: .regularExpression) != nil,
                          let action = body["action"] as? String, ["status", "connect"].contains(action) else {
                        Self.deliverAlongResult(id: id, result: ["ok": false, "error": "请在 Along App 中连接数据源"], webView: webView)
                        return
                    }
                    Task { @MainActor in
                        if action == "connect" { bridge.beginOkx(id: id, goalID: goalID, webView: webView) }
                        else {
                            let result: [String: Any]
                            do { result = ["ok": true, "value": try await Self.okxStatus(goalID: goalID)] }
                            catch { result = ["ok": false, "error": "无法读取 OKX 连接状态"] }
                            Self.deliverAlongResult(id: id, result: result, webView: webView)
                        }
                    }
                    return
                }
                if body["operation"] as? String == "notification" {
                    if ["readOnlyInventory","upcomingGoalReminder","eventTaskSync","eventTaskOpened","pendingLegacyNotification","legacyNotificationOpened"].contains(body["action"] as? String ?? ""), origin.protocol != "along" || origin.host != "app" {
                        Self.deliverAlongResult(id: id, result: ["ok":false,"error":"请在 Along 中查看提醒"], webView: webView)
                        return
                    }
                    Task {
                        let result: [String: Any]
                        do { result = ["ok": true, "value": try await Self.notificationOperation(body)] }
                        catch { result = ["ok": false, "error": error.localizedDescription] }
                        await MainActor.run { Self.deliverAlongResult(id: id, result: result, webView: webView) }
                    }
                    return
                }
                if body["operation"] as? String == "healthEvents" {
                    Task { @MainActor in
                        let result: [String: Any]
                        do {
                            guard origin.protocol == "along", origin.host == "app" else { throw AgentBridgeError.invalidConfiguration }
                            result = ["ok": true, "value": try await HealthEventDelivery.shared.configure()]
                        } catch { result = ["ok": false, "error": error.localizedDescription] }
                        Self.deliverAlongResult(id: id, result: result, webView: webView)
                    }
                    return
                }
                if body["operation"] as? String == "backgroundReview" {
                    let result: [String: Any]
                    do {
                        guard origin.protocol == "along", origin.host == "app",
                              let action = body["action"] as? String else { throw AgentBridgeError.invalidConfiguration }
                        let response = try BackgroundHealthReviews.shared.bridgeAction(action, value: body["value"] as? [String: Any] ?? [:])
                        result = ["ok": true, "value": response]
                    } catch { result = ["ok": false, "error": error.localizedDescription] }
                    Self.deliverAlongResult(id: id, result: result, webView: webView)
                    return
                }
                if body["operation"] as? String == "connection" {
                    Task { @MainActor in
                        var result: [String: Any]
                        do {
                            if body["action"] as? String == "workspace", origin.protocol != "along" || origin.host != "app" {
                                throw AgentBridgeError.invalidConfiguration
                            }
                            if body["action"] as? String == "save" {
                                guard origin.protocol == "along", origin.host == "app",
                                      let value = body["value"] as? [String: Any] else { throw AgentBridgeError.invalidConfiguration }
                                result = ["ok": true, "value": try await HealthEventDelivery.shared.saveConnection(value)]
                            } else { result = ["ok": true, "value": try Self.connectionOperation(body)] }
                            if origin.protocol != "along" || origin.host != "app", var value = result["value"] as? [String: Any] {
                                value.removeValue(forKey: "workspaceHandoff"); result["value"] = value
                            }
                        }
                        catch { result = ["ok": false, "error": error.localizedDescription] }
                        Self.deliverAlongResult(id: id, result: result, webView: webView)
                    }
                    return
                }
                Task {
                    var result: [String: Any]
                    do { result = ["ok": true, "value": try await Self.agentRequest(body)] }
                    catch {
                        result = ["ok": false, "error": error.localizedDescription]
                        // 回执透传（§4.2）：只有事件回执挂在错误上，其余错误形状不变。
                        if case let AgentBridgeError.receipt(receipt) = error { result["receipt"] = receipt }
                    }
                    await MainActor.run { Self.deliverAlongResult(id: id, result: result, webView: webView) }
                }
            }
        }

#if DEBUG
        // Deployment copies a request and (for commit) a private offer to these fixed app-container
        // files. Only the action is a request; no target credential enters argv/env or Web input.
        @MainActor static func processWorkspaceHandoffRequest() async {
            guard UIApplication.shared.isProtectedDataAvailable,
                  let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
            let manager = FileManager.default
            let request = cache.appendingPathComponent("AlongWorkspaceHandoff.request.json")
            guard manager.fileExists(atPath: request.path) else { return }
            func read(_ url: URL) throws -> [String: Any] {
                let a = try manager.attributesOfItem(atPath: url.path)
                guard a[.type] as? FileAttributeType == .typeRegular,
                      let size = a[.size] as? NSNumber, size.intValue > 0, size.intValue <= 256 * 1024 else { throw WorkspaceHandoffError.invalidState }
                try manager.setAttributes([.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600], ofItemAtPath: url.path)
                guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else { throw WorkspaceHandoffError.invalidState }
                return value
            }
            func write(_ name: String, _ value: [String: Any]) throws {
                let url = cache.appendingPathComponent(name)
                try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: url, options: [.atomic, .completeFileProtection])
                try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            }
            do {
                let input = try read(request)
                guard let action = input["action"] as? String else { throw WorkspaceHandoffError.invalidState }
                switch action {
                case "inventory":
                    guard Set(input.keys) == ["action"] else { throw WorkspaceHandoffError.invalidState }
                    try write("AlongWorkspaceHandoff.inventory.json", await EventTaskNotifications.shared.readOnlyInventory())
                case "prepare":
                    guard Set(input.keys) == ["action", "targetOrigin"], let target = input["targetOrigin"] as? String else { throw WorkspaceHandoffError.invalidState }
                    try write("AlongWorkspaceHandoff.challenge.json", HealthEventDelivery.shared.prepareWorkspaceHandoff(targetOrigin: target))
                case "commit":
                    guard Set(input.keys) == ["action"] else { throw WorkspaceHandoffError.invalidState }
                    let file = cache.appendingPathComponent("AlongWorkspaceHandoff.offer.json")
                    let result = try await HealthEventDelivery.shared.commitWorkspaceHandoff(read(file))
                    guard result["workspaceHandoff"] != nil else { throw WorkspaceHandoffError.invalidState }
                    try manager.removeItem(at: file)
                case "repairNotificationScope":
                    var repair = input
                    repair.removeValue(forKey: "action")
                    try write("AlongWorkspaceHandoff.repair.json", await HealthEventDelivery.shared.repairWorkspaceHandoffNotificationScope(repair))
                default: throw WorkspaceHandoffError.invalidState
                }
                try write("AlongWorkspaceHandoff.result.json", ["purpose": WorkspaceHandoffProof.purpose, "action": action,
                    "status": "completed", "checkedAt": ISO8601DateFormatter().string(from: Date())])
                try manager.removeItem(at: request)
            } catch {
                try? write("AlongWorkspaceHandoff.result.json", ["purpose": WorkspaceHandoffProof.purpose,
                    "status": "not_completed", "checkedAt": ISO8601DateFormatter().string(from: Date())])
            }
        }
#endif

        static func connectionOperation(_ input: [String: Any]) throws -> [String: Any] {
            switch input["action"] as? String {
            case "load":
                let saved = AlongConnectionStore.load()
                print("Along connection delivered to web: \(saved != nil)")
                return saved.map { HealthEventDelivery.shared.connectionForWeb($0) } ?? [:]
            case "workspace":
                guard let saved = AlongConnectionStore.load() else { return [:] }
                return HealthEventDelivery.shared.cachedWorkspaceBinding(saved)
            default: throw AgentBridgeError.invalidConfiguration
            }
        }

        static func notificationOperation(_ input: [String: Any]) async throws -> [String: Any] {
            let center = UNUserNotificationCenter.current()
            switch input["action"] as? String {
            case "readOnlyInventory":
                return await EventTaskNotifications.shared.readOnlyInventory()
            case "pendingLegacyNotification":
                return EventTaskNotifications.shared.legacyOpen.map { ["route":$0] } ?? [:]
            case "legacyNotificationOpened":
                if let id=(input["value"] as? [String:Any])?["id"] as? String { EventTaskNotifications.shared.ackLegacy(id) }
                return [:]
            case "eventTaskSync", "eventTaskOpened":
                guard let value = input["value"] as? [String:Any] else { throw AgentBridgeError.invalidConfiguration }
                if input["action"] as? String == "eventTaskSync" { return try await EventTaskNotifications.shared.synchronize(value) }
                EventTaskNotifications.shared.opened(value)
                return [:]
            case "enable":
                let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                return ["status": granted ? "authorized" : "denied"]
            case "status":
                let settings = await center.notificationSettings()
                return ["status": notificationStatus(settings.authorizationStatus)]
            case "dailyReminderStatus", "applyDailyReminders", "cancelDailyReminders":
                guard let value = input["value"] as? [String: Any] else { throw AgentBridgeError.invalidConfiguration }
                switch input["action"] as? String {
                case "applyDailyReminders": return try await DailyHealthReminders.apply(value)
                case "cancelDailyReminders": return try await DailyHealthReminders.cancel(value)
                default: return await DailyHealthReminders.status(try DailyReminderScope(value))
                }
            case "upcomingGoalReminder":
                guard let value = input["value"] as? [String: Any], let goalKey = value["goalKey"] as? String,
                      goalKey == "health" || (goalKey.hasPrefix("custom:") && (8...100).contains(goalKey.count))
                else { throw AgentBridgeError.invalidConfiguration }
                let pending = await center.pendingNotificationRequests()
                let prefix = healthReminderPrefix(goalKey)
                let candidates = pending.compactMap { request -> (Date, UNNotificationRequest, String)? in
                    guard let id = request.content.userInfo["taskId"] as? String,
                          request.content.userInfo["goalKey"] as? String == goalKey,
                          (request.identifier == prefix + notificationIdentifier(id) || DailyHealthReminders.owns(request, goalKey: goalKey)),
                          let trigger = request.trigger as? UNCalendarNotificationTrigger,
                          !trigger.repeats, let date = trigger.nextTriggerDate(), date > Date() else { return nil }
                    return (date, request, id)
                }
                guard let (date, request, taskID) = candidates.min(by: { $0.0 < $1.0 }) else { return [:] }
                return ["goalKey": goalKey, "taskId": taskID, "requestId": request.content.userInfo["requestId"] as? String ?? "", "title": request.content.title,
                        "scheduledFor": ISO8601DateFormatter().string(from: date)]
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

        @MainActor private static func enqueueHealthReminderReplacement(_ items: [[String: Any]], goalKey: String,
                    center: UNUserNotificationCenter) async throws -> [String: Any] {
            try await DailyHealthReminders.serialized { try await replaceHealthReminders(items, goalKey: goalKey, center: center) }
        }

        private static func replaceHealthReminders(_ items: [[String: Any]], goalKey: String, center: UNUserNotificationCenter) async throws -> [String: Any] {
            let prefix = healthReminderPrefix(goalKey)
            var desired: [UNNotificationRequest] = []
            var identifiers = Set<String>()
            let existingAtStart = await center.pendingNotificationRequests()
            var dailyCoverage = Set<String>()
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
                if let dailyID = DailyHealthReminders.coveredAdoptedID(taskID, goalKey: goalKey, date: date, pending: existingAtStart) {
                    guard dailyCoverage.insert(dailyID).inserted else { throw AgentBridgeError.server("健康提醒重复") }
                    continue
                }
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
            let old = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(prefix) && !DailyHealthReminders.preservesIndependentRequest($0) }
            let permission = await center.notificationSettings().authorizationStatus
            let permitted = [.authorized, .provisional, .ephemeral].contains(permission)
            if (desired.isEmpty && dailyCoverage.isEmpty) || !permitted {
                center.removePendingNotificationRequests(withIdentifiers: old.map(\.identifier))
                let remaining = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(prefix) && !DailyHealthReminders.preservesIndependentRequest($0) }.count
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
            let pending = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(prefix) && (identifiers.contains($0.identifier) || !DailyHealthReminders.preservesIndependentRequest($0)) }
            guard Set(pending.map(\.identifier)) == identifiers else {
                throw AgentBridgeError.server("系统中的健康提醒与当前安排不一致，请稍后重试")
            }
            let confirmed = Set(await center.pendingNotificationRequests().map(\.identifier))
            guard dailyCoverage.isSubset(of: confirmed) else { throw AgentBridgeError.server("每日提醒已变化，请重新读取") }
            return ["status": "scheduled", "scheduledCount": pending.count + dailyCoverage.count]
        }

        func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
            completionHandler([.banner, .list, .sound])
        }

        func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                    withCompletionHandler completionHandler: @escaping () -> Void) {
            EventTaskNotifications.shared.receiveLegacy(response.notification.request)
            completionHandler()
        }

        static func legacyPayload(_ request: UNNotificationRequest) -> [String:String]? {
            let info=request.content.userInfo
            guard let goal=info["goalKey"] as? String, ["health","finance","custom"].contains(goal) ||
                    goal.range(of:#"^custom:[A-Za-z0-9_:-]{1,90}$"#,options:.regularExpression) != nil,
                  let kind=info["kind"] as? String, ["task","goal"].contains(kind) else { return nil }
            var payload=["kind":kind,"goalKey":goal,"legacyOpenId":UUID().uuidString]
            for key in ["taskId","requestId"] {
                if let value=info[key] as? String, !value.isEmpty, value.count<=160 {payload[key]=value}
            }
            if let id=payload["taskId"], let timer=request.trigger as? UNCalendarNotificationTrigger,
               request.identifier == healthReminderPrefix(goal)+notificationIdentifier(id) || DailyHealthReminders.owns(request,goalKey:goal) {
                payload["reminderTitle"]=String(request.content.title.prefix(80))
                payload["reminderBody"]=String(request.content.body.prefix(180))
                if let date=timer.dateComponents.date {payload["reminderAt"]=ISO8601DateFormatter().string(from:date)}
                payload["dailyTopic"]=DailyHealthReminders.deliveryTopic(request,goalKey:goal)
                payload["planTaskId"]=DailyHealthReminders.deliveryTaskID(request,goalKey:goal)
            }
            return payload
        }

        func openNotification(_ payload: [String: String]) {
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

        static func okxStatus(goalID: String) async throws -> [String: Any] {
            try await PhoneSourceCoordinator.shared.status(goalID: goalID)
        }

        static func agentRequest(_ input: [String: Any], background: Bool = false, privateNotificationRequest: Bool = false, privateSourceRequest: Bool = false, privateWorkspaceHandoffRequest: Bool = false) async throws -> [String: Any] {
            guard let base = input["baseURL"] as? String, let components = URLComponents(string: base),
                  components.scheme == "https", let host = components.host,
                  AlongConnectionStore.hostAccepted(host),
                  components.user == nil, components.password == nil,
                  components.path.isEmpty, components.query == nil, components.fragment == nil,
                  let path = input["path"] as? String,
                  // 新链路端点（docs/stage-a-tech-design.md §2.4.2）：全部 POST，语义与旧路径一致——仅网络转发。
                  (["/pair", "/connection/verify", "/connection/status", "/goal/event", "/super-agent/tasks", "/super-agent/tasks/status", "/super-agent/daily-delegation",
                   "/super-agent/goals", "/super-agent/goals/status", "/events", "/sync", "/sync/ack"].contains(path) || (privateWorkspaceHandoffRequest && ["/workspace-handoff/status"].contains(path)) || (privateNotificationRequest && ["/notifications/device","/notifications/scheduled"].contains(path)) || (privateSourceRequest && ["/sources/okx", "/sources/device"].contains(path))),
                  let body = input["body"] as? [String: Any],
                  let url = URL(string: base + path),
                  // 旧 pin 形态（Mac 私网）必须带合法 64hex 叶指纹；云端系统信任形态不需要。
                  // 这里在入口守卫里就分好形态，避免后面再判一次。
                  AlongConnectionStore.acceptsPin(input["fingerprint"] as? String,
                                                  policy: AlongConnectionStore.trustPolicy(forHost: host))
            else { throw AgentBridgeError.invalidConfiguration }
            // 信任策略由主机形态推导（docs/iphone-ca-profile-design.md §2.2）：
            // 私网 IPv4 走旧叶指纹 pin，云端主机交给系统信任评估。
            // 不接受 JavaScript 自报 trustPolicy——放宽策略必须走原生自己的判定。
            guard AlongConnectionStore.permitsPairedTransport(input) else { throw AgentBridgeError.invalidConfiguration }
            let policy = AlongConnectionStore.trustPolicy(forHost: host)
            let fingerprint = AlongConnectionStore.pinnedFingerprint(input["fingerprint"] as? String, policy: policy)
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = background ? 8 : (["/connection/verify", "/sources/device", "/workspace-handoff/status"].contains(path) ? 12 : 120)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let token = input["token"] as? String, !token.isEmpty {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let delegate: URLSessionDelegate = fingerprint.map { PinnedAgentDelegate(fingerprint: $0) } ?? SystemTrustAgentDelegate(expectedHost: host)
            let configuration = URLSessionConfiguration.ephemeral
            configuration.waitsForConnectivity = !background
            configuration.timeoutIntervalForResource = background ? 10 : (["/connection/verify", "/sources/device", "/workspace-handoff/status"].contains(path) ? 15 : 120)
            // Every session is tied to one validated origin and disallows redirects.
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
                // 事件回执（/events 400 rejected / 409 conflict，docs/stage-a-tech-design.md §4.2）：回执体
                // 挂在错误上原样交还 web 层，由它按处置口径删本地待同步项或保留重试；纯协议透传，不改交互。
                if let status = result["status"] as? String, ["rejected", "conflict", "accepted", "duplicate"].contains(status) {
                    throw AgentBridgeError.receipt(result)
                }
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
            if UIApplication.shared.applicationState != .background { BackgroundHealthReviews.shared.foregroundStarted() }
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

        // Only a person tapping a public HTTPS source may leave the bundled page.
        // Automatic redirects, script popups and URLs containing credentials stay blocked.
        static func publicSource(_ url: URL) -> Bool {
            guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  parts.scheme == "https", parts.user == nil, parts.password == nil,
                  parts.port == nil || parts.port == 443,
                  let host = parts.host?.lowercased(), url.absoluteString.count <= 2048,
                  host.range(of: #"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"#, options: .regularExpression) != nil,
                  host.range(of: #"(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$"#, options: .regularExpression) == nil,
                  url.absoluteString.rangeOfCharacter(from: .controlCharacters) == nil,
                  !url.absoluteString.contains("\\") else { return false }
            return !(parts.queryItems ?? []).contains { item in
                item.name.range(of: #"^(?:api[_-]?key|access[_-]?token|token|password|secret|authorization|credential)$"#,
                                options: [.regularExpression, .caseInsensitive]) != nil
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.navigationType == .linkActivated,
               let url = navigationAction.request.url, Self.publicSource(url) {
                UIApplication.shared.open(url)
            }
            return nil
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            let legacyDuolingo = url.scheme == "https" && ["duolingo.com", "www.duolingo.com"].contains(url.host ?? "")
            if legacyDuolingo || (navigationAction.navigationType == .linkActivated && Self.publicSource(url)) {
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
    // 事件回执（/events 200/400/409 的回执体）：仅承载给 web 层做处置，不影响用户可见文案。
    case receipt([String: Any])

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
        case .receipt(let body): body["reason"] as? String ?? body["error"] as? String ?? "Along 请求失败"
        }
    }
}

// 云端 DNS 与公网 IPv4 的系统信任评估委托（docs/iphone-ca-profile-design.md §2.1）。
//
// 关键约束：这里不做任何自己的信任判断，也不返回 useCredential。
//   - 链、可信锚、请求主机名或 IP SAN、有效期与 ATS 全部交给 URL Loading System 评估；
//   - 挑战的主机必须与当前连接的期望主机一致，不一致就取消，不提供额外凭证；
//   - 不调用 SecTrustSetAnchorCertificates 塞入 App 内证书或服务器下发的根；
//   - 不设置忽略证书错误的例外，也没有「系统评估失败再试旧叶 pin」的降级分支。
// 失败就是失败：没有安装 CA 描述文件、没有开启完全信任、SAN 错、证书过期都会在
// 发送 HTTP 层配对码/Bearer/业务数据之前就断掉。
final class SystemTrustAgentDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    private let expectedHost: String
    init(expectedHost: String) { self.expectedHost = expectedHost.lowercased() }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let host = challenge.protectionSpace.host.lowercased()
        guard host == expectedHost else {
            print("Along server trust challenge for unexpected host: \(host)")
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        // performDefaultHandling = 由系统评估证书链、可信锚、主机名与有效期，并保留 ATS 规则。
        completionHandler(.performDefaultHandling, nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // 重定向即拒绝：不能把 Bearer 或配对码转给另一个地址（docs/iphone-ca-profile-design.md §2.1）。
        completionHandler(nil)
    }
}

// Mac 私网旧连接的叶指纹钉扎委托：行为不变（docs/iphone-ca-profile-design.md §2.2）。
// 已知局限（错误主机名/过期叶证书只比指纹）不在本方案范围内，本设计不宣称已修复该本地机制。
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
                if bridge.managedGoal != nil {
                    Section {
                        Toggle("允许 DSH 在后台评估当前目标", isOn: Binding(get: { bridge.backgroundSelected }, set: { bridge.chooseBackground($0) }))
                    } footer: {
                        Text("已有授权可单独切换，立即生效。DSH 只使用已选摘要，需要能连接已配对的 Mac。锁屏或离线时，打开 Along 后补读。")
                    }
                }
                Section("睡眠评分") {
                    Text("Apple 睡眠评分目前没有可供第三方 App 直接读取的 HealthKit 类型。Along 可读取昨晚睡眠时长，但不会把它伪装成苹果评分。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let preview = bridge.preview {
                    Section("导入前预览") {
                        ForEach(preview.selected) { metric in
                            LabeledContent(metric.title, value: preview.displayValue(for: metric))
                            ForEach(preview.historyPreview(for: metric), id: \.self) { line in
                                Text(line).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        Text("睡眠摘要包含最近一夜的首末睡眠记录时间。运动摘要包含按运动类型、星期和小时分组的次数与时长。空值表示当前读不到记录。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section("导入 Along") {
                        Text("确认后，已配对的 Mac 可使用上述所选摘要和两个七天窗口的汇总，结合当前目标评估任务调整。")
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

@MainActor
extension AlongBridgeModel {
    func beginOkx(id: String, goalID: String, webView: WKWebView) {
        guard okxRequest == nil, !showSheet else {
            AlongWebView.Coordinator.deliverAlongResult(id: id, result: ["ok": false, "error": "请先关闭当前连接页面"], webView: webView)
            return
        }
        okxRequest = (id, goalID, webView)
        okxConnection = OkxPresentation(goalID: goalID)
    }

    func finishOkx() {
        guard let pending = okxRequest else { return }
        okxRequest = nil
        Task { @MainActor in
            let result: [String: Any]
            do { result = ["ok": true, "value": try await AlongWebView.Coordinator.okxStatus(goalID: pending.goalID)] }
            catch { result = ["ok": false, "error": "无法读取连接状态，请检查 Mac 连接后重试"] }
            AlongWebView.Coordinator.deliverAlongResult(id: pending.id, result: result, webView: pending.view)
        }
    }
}
