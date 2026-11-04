import SwiftUI
import WebKit
import CryptoKit
import Security

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
    private var lastRefresh = Date.distantPast

    func attach(_ webView: WKWebView) {
        self.webView = webView
        startObservers()
        refreshHealth()
    }

    private var savedSelection: Set<HealthMetric> {
        Set((UserDefaults.standard.stringArray(forKey: "along.health.selectedTypes") ?? []).compactMap(HealthMetric.init(rawValue:)))
    }

    private func startObservers() {
        let selected = savedSelection
        guard !selected.isEmpty else { return }
        reader.observe(selected) { [weak self] in
            Task { @MainActor in self?.refreshHealth() }
        }
    }

    func refreshHealth() {
        let selected = savedSelection
        guard !selected.isEmpty, !refreshing, Date().timeIntervalSince(lastRefresh) > 8 else { return }
        refreshing = true
        lastRefresh = Date()
        Task {
            defer { refreshing = false }
            do {
                let summary = try await reader.read(selected, requestPermission: false)
                guard let data = try? JSONSerialization.data(withJSONObject: summary.browserSnapshot()),
                      let json = String(data: data, encoding: .utf8) else { return }
                _ = try? await webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('along-health-update', {detail: \(json)}))")
            } catch { errorMessage = error.localizedDescription }
        }
    }

    func refreshSnapshot(id: String, webView: WKWebView) {
        let selected = savedSelection
        guard !selected.isEmpty else {
            deliver(id: id, result: ["ok": false, "error": "请先连接 Apple Health"], to: webView)
            return
        }
        Task {
            do {
                let summary = try await reader.read(selected, requestPermission: false)
                deliver(id: id, result: ["ok": true, "snapshot": summary.browserSnapshot()], to: webView)
            } catch {
                deliver(id: id, result: ["ok": false, "error": error.localizedDescription], to: webView)
            }
        }
    }

    private func deliver(id: String, result: [String: Any], to view: WKWebView) {
        guard let arguments = try? JSONSerialization.data(withJSONObject: [id, result]),
              let json = String(data: arguments, encoding: .utf8) else { return }
        view.evaluateJavaScript("window.__alongHealthBridgeFinish(...\(json))")
    }

    func begin(id: String, webView: WKWebView) {
        guard requestID == nil else { return }
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
        UserDefaults.standard.set(preview.selected.map(\.rawValue), forKey: "along.health.selectedTypes")
        startObservers()
        finish(snapshot: preview.browserSnapshot())
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

struct AlongWebView: UIViewRepresentable {
    @ObservedObject var bridge: AlongBridgeModel
    private let site = URL(string: "along://app/index.html")!

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge) }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "alongHealth")
        controller.add(context.coordinator, name: "alongHealthRefresh")
        controller.add(context.coordinator, name: "alongAgent")
        controller.addUserScript(WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.setURLSchemeHandler(BundledWebSchemeHandler(), forURLScheme: "along")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: site))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static let bridgeScript = """
    (() => {
      const pending = new Map();
      window.__alongHealthBridgeFinish = (id, result) => {
        const item = pending.get(id); if (!item) return;
        pending.delete(id);
        if (result.ok) item.resolve(result.snapshot);
        else item.reject(new Error(result.error || '导入已取消'));
      };
      window.AlongHealthBridge = {
        connect: ({types} = {}) => new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          pending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongHealth.postMessage({id, types});
        }),
        refresh: () => new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          pending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongHealthRefresh.postMessage({id});
        })
      };
      const agentPending = new Map();
      window.__alongAgentBridgeFinish = (id, result) => {
        const item = agentPending.get(id); if (!item) return;
        agentPending.delete(id);
        if (result.ok) item.resolve(result.value);
        else item.reject(new Error(result.error || 'Agent 请求失败'));
      };
      window.AlongAgentBridge = {
        request: ({baseURL, fingerprint, path, token, body}) => new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          agentPending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongAgent.postMessage({id, baseURL, fingerprint, path, token, body});
        })
      };
    })();
    """

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let bridge: AlongBridgeModel
        init(bridge: AlongBridgeModel) { self.bridge = bridge }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = message.frameInfo.securityOrigin
            let trustedOrigin = (origin.protocol == "along" && origin.host == "app") ||
                                (origin.protocol == "https" && origin.host == "artstur.github.io")
            guard ["alongHealth", "alongHealthRefresh", "alongAgent"].contains(message.name), message.frameInfo.isMainFrame,
                  trustedOrigin,
                  let body = message.body as? [String: Any], let id = body["id"] as? String,
                  let webView = message.webView else { return }
            if message.name == "alongHealth" {
                Task { @MainActor in bridge.begin(id: id, webView: webView) }
            } else if message.name == "alongHealthRefresh" {
                Task { @MainActor in bridge.refreshSnapshot(id: id, webView: webView) }
            } else {
                Task {
                    let result: [String: Any]
                    do { result = ["ok": true, "value": try await Self.agentRequest(body)] }
                    catch { result = ["ok": false, "error": error.localizedDescription] }
                    guard let data = try? JSONSerialization.data(withJSONObject: [id, result]),
                          let json = String(data: data, encoding: .utf8) else { return }
                    await MainActor.run { webView.evaluateJavaScript("window.__alongAgentBridgeFinish(...\(json))") }
                }
            }
        }

        static func agentRequest(_ input: [String: Any]) async throws -> [String: Any] {
            guard let base = input["baseURL"] as? String, let components = URLComponents(string: base),
                  components.scheme == "https", let host = components.host,
                  host.split(separator: ".").count == 4,
                  host.split(separator: ".").allSatisfy({ Int($0).map { (0...255).contains($0) } ?? false }),
                  (host.hasPrefix("192.168.") || host.hasPrefix("10.") ||
                   ((Int(host.split(separator: ".")[0]) == 172) &&
                    (16...31).contains(Int(host.split(separator: ".")[1]) ?? 0))),
                  components.path.isEmpty, components.query == nil, components.fragment == nil,
                  let fingerprint = input["fingerprint"] as? String,
                  fingerprint.count == 64, fingerprint.allSatisfy(\.isHexDigit),
                  let path = input["path"] as? String,
                  ["/pair", "/goal/chat", "/goal/event"].contains(path),
                  let body = input["body"] as? [String: Any],
                  let url = URL(string: base + path) else { throw AgentBridgeError.invalidConfiguration }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 120
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let token = input["token"] as? String, !token.isEmpty {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let delegate = PinnedAgentDelegate(fingerprint: fingerprint.uppercased())
            let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
            defer { session.finishTasksAndInvalidate() }
            let (data, response) = try await session.data(for: request)
            guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AgentBridgeError.invalidResponse }
            guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode) else {
                throw AgentBridgeError.server(result["error"] as? String ?? "Mac Agent 请求失败")
            }
            return result
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            print("Along web view loaded: \(webView.url?.absoluteString ?? "unknown")")
            bridge.webLoading = false
            bridge.webError = nil
            Task { @MainActor in bridge.attach(webView) }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) {
            print("Along provisional navigation failed: \(error.localizedDescription)")
            bridge.webLoading = false
            bridge.webError = error.localizedDescription
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("Along navigation failed: \(error.localizedDescription)")
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
            let trustedRemote = url.scheme == "https" && url.host == "artstur.github.io" &&
                                url.path.hasPrefix("/Personality-Demo/")
            let trustedBundled = url.scheme == "along" && url.host == "app"
            decisionHandler(trustedBundled || trustedRemote ? .allow : .cancel)
        }
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
    case invalidConfiguration, invalidResponse, server(String)
    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: "Mac Agent 地址或证书指纹不正确"
        case .invalidResponse: "Mac Agent 返回格式不正确"
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
                        Text("仅将这些汇总值导入本机页面，不导入原始记录、精确时间点或设备信息。无可读取记录可能意味着尚无记录，也可能是没有读取权限。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section("导入 Along") {
                        Text("确认后把上述摘要导入这台 iPhone 上的 Along 页面。只有你另行配对 Mac Agent 后，目标问答或显著的健身时长变化才会把目标和健身分钟数汇总发给这台 Mac；不发送原始记录。")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("确认导入本机 Along") { bridge.confirmImport() }
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
