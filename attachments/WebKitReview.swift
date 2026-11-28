import AppKit
import WebKit
import UniformTypeIdentifiers

final class Assets: NSObject, WKURLSchemeHandler {
    let directory: URL
    init(_ path: String) { directory = URL(fileURLWithPath: path, isDirectory: true) }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        do {
            guard let url = task.request.url, url.host == "app" else { throw URLError(.badURL) }
            let file = directory.appendingPathComponent(url.lastPathComponent)
            let data = try Data(contentsOf: file)
            let mime = file.pathExtension == "mjs" ? "text/javascript" :
                UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8"))
            task.didReceive(data)
            task.didFinish()
        } catch { task.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

@MainActor
func review() async throws {
    let store = WKWebsiteDataStore(forIdentifier: UUID())
    defer { WKWebsiteDataStore.remove(forIdentifier: store.identifier!) { _ in } }
    let scheme = Assets(CommandLine.arguments[1])
    let window = NSWindow(contentRect: CGRect(x:0,y:0,width:390,height:844), styleMask:[.titled], backing:.buffered, defer:false)
    func makeView() async throws -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = store
        config.setURLSchemeHandler(scheme, forURLScheme: "along")
        let view = WKWebView(frame:window.contentLayoutRect, configuration:config)
        window.contentView = view
        view.load(URLRequest(url:URL(string:"along://app/index.html?build=108")!))
        for _ in 0..<80 {
            let ready = try? await view.evaluateJavaScript("!!document.querySelector('[data-action=open-settings]')") as? Bool
            if ready == true { return view }
            try await Task.sleep(for:.milliseconds(200))
        }
        throw CocoaError(.fileReadUnknown)
    }
    func check(_ view: WKWebView, _ source: String, _ label: String) async throws {
        guard (try await view.evaluateJavaScript(source) as? Bool) == true else {
            throw NSError(domain:label,code:1)
        }
        print(label)
    }
    var view: WKWebView? = try await makeView()
    try await check(view!, "document.querySelector('[data-action=open-settings]').click(); ['昵称','数据源','Along 服务'].every(label=>!!document.querySelector('section[aria-label=\"'+label+'\"]'))", "WKWebView: settings entry displays all three sections")
    try await check(view!, "var field = document.querySelector('[name=nickname]'); field.value='Review88'; field.dispatchEvent(new Event('input',{bubbles:true})); field.form.requestSubmit(); document.querySelector('[name=nickname]').value==='Review88'", "WKWebView: nickname saved using actual DOM events")
    view = nil
    view = try await makeView()
    try await check(view!, "document.querySelector('[data-action=open-settings]').click(); document.querySelector('[name=nickname]').value==='Review88'", "WKWebView: nickname persists in a new WebView sharing the same local store")
    try await check(view!, "document.querySelector('[data-action=settings-back]').click(); !document.querySelector('#nickname-form')", "WKWebView: Back returns to the preceding screen")
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
Task { @MainActor in
    do { try await review(); exit(0) }
    catch { print("WKWebView review failed: \(error)"); exit(1) }
}
app.run()
