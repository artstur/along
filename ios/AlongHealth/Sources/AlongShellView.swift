import SwiftUI
import WebKit

@main
struct AlongHealthApp: App {
    @StateObject private var bridge = AlongBridgeModel()

    var body: some Scene {
        WindowGroup {
            AlongWebView(bridge: bridge)
                .ignoresSafeArea(edges: .bottom)
                .sheet(isPresented: $bridge.showSheet, onDismiss: { bridge.dismissIfPending() }) {
                    HealthSyncSheet(bridge: bridge)
                        .interactiveDismissDisabled(bridge.busy)
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
    @Published var serviceURL = UserDefaults.standard.string(forKey: "along.sync.url") ?? ""
    @Published var pairCode = ""

    private let reader = HealthKitReader()
    private let syncClient = AlongSyncClient()
    private var requestID: String?
    private weak var webView: WKWebView?

    func begin(id: String, webView: WKWebView) {
        guard requestID == nil else { return }
        requestID = id
        self.webView = webView
        selection = []
        preview = nil
        errorMessage = nil
        pairCode = ""
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

    func confirmSync() {
        guard !busy, let preview else { return }
        busy = true
        errorMessage = nil
        Task {
            defer { busy = false }
            do {
                guard preview.hasReadableValue else { throw SyncError.noReadableData }
                let endpoint = serviceURL.trimmingCharacters(in: .whitespacesAndNewlines)
                let token: String
                if !pairCode.isEmpty {
                    token = try await syncClient.pair(serviceURL: endpoint, code: pairCode)
                    SyncTokenStore.save(token, for: endpoint)
                    pairCode = ""
                } else if let existing = SyncTokenStore.read(for: endpoint) {
                    token = existing
                } else { throw SyncError.missingPairCode }
                try await syncClient.sync(preview, serviceURL: endpoint, token: token)
                UserDefaults.standard.set(endpoint, forKey: "along.sync.url")
                finish(snapshot: preview.browserSnapshot())
            } catch { errorMessage = error.localizedDescription }
        }
    }

    func cancel() { finish(error: "已取消健康数据同步") }
    func dismissIfPending() { if requestID != nil { finish(error: "已取消健康数据同步") } }

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
    private let site = URL(string: "https://personality-demo.pages.dev/")!

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge) }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "alongHealth")
        controller.addUserScript(WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
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
        else item.reject(new Error(result.error || '同步已取消'));
      };
      window.AlongHealthBridge = {
        connect: ({types} = {}) => new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          pending.set(id, {resolve, reject});
          window.webkit.messageHandlers.alongHealth.postMessage({id, types});
        })
      };
    })();
    """

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let bridge: AlongBridgeModel
        init(bridge: AlongBridgeModel) { self.bridge = bridge }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "alongHealth", message.frameInfo.isMainFrame,
                  message.frameInfo.securityOrigin.host == "personality-demo.pages.dev",
                  let body = message.body as? [String: Any], let id = body["id"] as? String,
                  let webView = message.webView else { return }
            Task { @MainActor in bridge.begin(id: id, webView: webView) }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            decisionHandler(url.scheme == "https" && url.host == "personality-demo.pages.dev" ? .allow : .cancel)
        }
    }
}

struct HealthSyncSheet: View {
    @ObservedObject var bridge: AlongBridgeModel

    var body: some View {
        NavigationStack {
            Form {
                Section("选择要读取的数据") {
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
                }
                if let preview = bridge.preview {
                    Section("发送前预览") {
                        ForEach(preview.selected) { metric in
                            LabeledContent(metric.title, value: preview.displayValue(for: metric))
                        }
                        Text("仅发送这些汇总值，不发送原始记录、精确时间点或设备信息。无可读取记录可能意味着尚无记录，也可能是没有读取权限。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section("Along 服务") {
                        TextField("https://…trycloudflare.com", text: $bridge.serviceURL)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        SecureField("一次性配对码（首次连接时输入）", text: $bridge.pairCode)
                            .keyboardType(.numberPad)
                        Text("确认后才会向上方地址发送所选摘要；没有后台自动同步。")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button(bridge.busy ? "正在同步…" : "确认并同步到 Along") { bridge.confirmSync() }
                            .disabled(bridge.busy || !preview.hasReadableValue || bridge.serviceURL.isEmpty)
                    }
                }
                if let error = bridge.errorMessage {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("连接 Apple Health")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("取消") { bridge.cancel() }.disabled(bridge.busy) } }
        }
    }
}
