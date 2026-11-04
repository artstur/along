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

    private let reader = HealthKitReader()
    private var requestID: String?
    private weak var webView: WKWebView?

    func begin(id: String, webView: WKWebView) {
        guard requestID == nil else { return }
        requestID = id
        self.webView = webView
        selection = []
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

    func confirmImport() {
        guard !busy, let preview, preview.hasReadableValue else { return }
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
        else item.reject(new Error(result.error || '导入已取消'));
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
                    Section("导入前预览") {
                        ForEach(preview.selected) { metric in
                            LabeledContent(metric.title, value: preview.displayValue(for: metric))
                        }
                        Text("仅将这些汇总值导入本机页面，不导入原始记录、精确时间点或设备信息。无可读取记录可能意味着尚无记录，也可能是没有读取权限。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section("导入 Along") {
                        Text("确认后只把上述摘要交给这台 iPhone 上的 Along 页面，保存在 App 的本地数据中；不会发送给 Mac 服务。")
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
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("取消") { bridge.cancel() }.disabled(bridge.busy) } }
        }
    }
}
