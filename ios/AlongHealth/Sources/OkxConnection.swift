import SwiftUI
import CoreFoundation

/// Credentials stay in this native sheet until sent to the pinned, paired Host.
/// Only the Host's account summary is rendered; nothing is passed to the WebView.
@MainActor
struct OKXConnectionSheet: View {
    let goalID: String
    let onClose: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var apiKey = ""
    @State private var secretKey = ""
    @State private var passphrase = ""
    @State private var site: OKXSite = .global
    @State private var snapshot: OKXConnectionSnapshot?
    @State private var errorMessage: String?
    @State private var busy = false
    @State private var operationID: UUID?
    @State private var operation: Task<Void, Never>?
    @State private var closed = false

    var body: some View {
        NavigationStack {
            Form {
                Section("连接状态") {
                    LabeledContent("OKX", value: snapshot?.connected == true ? "已连接 · 只读" : (snapshot == nil ? "尚未读取" : "未连接"))
                    if let snapshot, snapshot.connected {
                        if let date = snapshot.lastSyncedAt {
                            LabeledContent("最近同步") {
                                Text(date, format: .dateTime.year().month().day().hour().minute())
                                    .multilineTextAlignment(.trailing)
                            }
                        }
                        if let summary = snapshot.summary {
                            LabeledContent("交易账户权益（USD）", value: summary.equity)
                            LabeledContent("资产种类", value: String(summary.assetCount))
                            LabeledContent("持仓数量", value: String(summary.positionCount))
                        }
                        Button("刷新账户摘要") { start(.refresh) }
                            .disabled(busy)
                        Button("断开连接", role: .destructive) { start(.disconnect) }
                            .disabled(busy)
                    } else {
                        Button("重新读取状态") { start(.status) }
                            .disabled(busy)
                    }
                    if busy { ProgressView("正在连接 Mac…") }
                }

                if snapshot?.connected != true {
                    Section {
                        Picker("OKX 站点", selection: $site) {
                            ForEach(OKXSite.allCases) { value in
                                Text(value.title).tag(value)
                            }
                        }
                        Link("前往 OKX 创建只读 API Key", destination: site.settingsURL)
                        credentialField("API Key", text: $apiKey)
                        credentialField("Secret Key", text: $secretKey)
                        credentialField("Passphrase", text: $passphrase)
                        Button("验证并连接") { start(.connect) }
                            .disabled(busy || !credentialsReady)
                    } header: {
                        Text("连接只读账户")
                    } footer: {
                        Text("在 OKX 仅勾选读取权限，完成后回到 Along 填写三项凭证。Along 会核实实际权限并读取交易账户摘要。凭证经加密连接发送至已配对的 Mac 保存，不进入网页或 Agent。")
                    }
                    .disabled(busy)
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("连接 OKX")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { close() }
                        .disabled(busy)
                }
            }
        }
        .task { start(.status) }
        .onChange(of: goalID) { _, _ in
            operationID = nil
            operation?.cancel()
            operation = nil
            busy = false
            clearCredentials()
            snapshot = nil
            start(.status)
        }
        .onDisappear { finishClose() }
        .interactiveDismissDisabled(busy)
    }

    private var credentialsReady: Bool {
        [apiKey, secretKey, passphrase].allSatisfy { !$0.isEmpty && $0.count <= 256 }
    }

    private func credentialField(_ title: String, text: Binding<String>) -> some View {
        SecureField(title, text: text)
            .textContentType(nil)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .privacySensitive()
            .accessibilityLabel(title)
    }

    private func start(_ action: OKXConnectionAction) {
        guard !busy, !closed else { return }
        guard let pairing = AlongConnectionStore.load() else {
            errorMessage = "请先连接已配对的 Mac，再连接 OKX。"
            return
        }
        let id = UUID()
        operationID = id
        busy = true
        errorMessage = nil
        var body: [String: Any] = ["action": action.rawValue, "goalId": goalID]
        if action == .connect {
            guard credentialsReady else { busy = false; return }
            body["site"] = site.rawValue
            body["credentials"] = ["apiKey": apiKey, "secretKey": secretKey, "passphrase": passphrase]
        }
        var input: [String: Any] = pairing
        input["path"] = "/sources/okx"
        input["body"] = body
        operation = Task { @MainActor in
            defer {
                if operationID == id { busy = false; operation = nil }
            }
            do {
                let result = try await AlongWebView.Coordinator.agentRequest(input, privateSourceRequest: true)
                guard !Task.isCancelled, !closed, operationID == id else { return }
                guard AlongConnectionStore.load() == pairing else {
                    clearCredentials()
                    snapshot = nil
                    errorMessage = "Mac 配对已变化，请关闭后重新连接。"
                    return
                }
                guard let next = OKXConnectionSnapshot(result),
                      ((action != .connect && action != .refresh) || next.connected),
                      action != .disconnect || !next.connected else {
                    errorMessage = action.failureMessage
                    return
                }
                snapshot = next
                if action == .connect || action == .disconnect { clearCredentials() }
            } catch {
                guard !Task.isCancelled, !closed, operationID == id else { return }
                if AlongConnectionStore.load() != pairing {
                    clearCredentials()
                    snapshot = nil
                }
                // Never surface an arbitrary server/transport string that could contain credentials.
                errorMessage = action.failureMessage(for: error)
            }
        }
    }

    private func clearCredentials() {
        apiKey = ""
        secretKey = ""
        passphrase = ""
    }

    private func finishClose() {
        guard !closed else { return }
        closed = true
        operationID = nil
        operation?.cancel()
        operation = nil
        busy = false
        clearCredentials()
        onClose()
    }

    private func close() {
        finishClose()
        dismiss()
    }
}

private enum OKXSite: String, CaseIterable, Identifiable {
    case global, eea, us
    var id: String { rawValue }
    var title: String {
        switch self {
        case .global: "Global · www.okx.com"
        case .eea: "EEA · my.okx.com"
        case .us: "US · app.okx.com"
        }
    }
    var settingsURL: URL {
        switch self {
        case .global: URL(string: "https://www.okx.com/account/my-api")!
        case .eea: URL(string: "https://my.okx.com/account/my-api")!
        case .us: URL(string: "https://app.okx.com/account/my-api")!
        }
    }
}

private enum OKXConnectionAction: String {
    case status, connect, refresh, disconnect
    var failureMessage: String {
        switch self {
        case .status: "未能读取连接状态。请确认已配对的 Mac 在线后重试。"
        case .connect: "连接未完成，请稍后重试。"
        case .refresh: "本次刷新失败，仍显示上次同步的摘要。请确认 Mac 在线及 OKX 连接有效后重试。"
        case .disconnect: "断开失败。请确认 Mac 在线后重试，凭证尚未确认删除。"
        }
    }

    func failureMessage(for error: Error) -> String {
        let reason: String
        if case let AgentBridgeError.server(message) = error {
            // Exact matches only: these are Host-owned constants, never raw OKX messages.
            switch message {
            case "OKX 请求超时，请稍后重试。":
                reason = "Mac 请求 OKX 超时。请检查 Mac 到 OKX 的网络；这不代表凭证错误。"
            case "暂时无法连接 OKX，请稍后重试。":
                reason = "Mac 无法连接 OKX。请检查 Mac 到 OKX 的网络后重试。"
            case "仅支持只读 API Key，请关闭交易和提现权限后重试。",
                 "OKX 未接受请求，请检查凭证、所属站点及 IP 白名单。",
                 "OKX 返回的数据无法验证，请稍后重试。",
                 "本机 OKX 凭证存储不可用，请检查后重试。",
                 "目标或配对已变化，本次连接未保存。",
                 "请完整填写 OKX API 凭证。",
                 "此目标尚未连接 OKX。",
                 "这个目标当前无法连接 OKX，请同步目标后重试",
                 "配对已变化，请重新打开连接",
                 "请先配对这台 Mac":
                reason = message
            case "代理未能连接到 Mac。请确认当前代理或 VPN 允许 Along 直连局域网，再重试评估。",
                 "连接 Mac 失败。请让 iPhone 和 Mac 接入可互访的网络，并确认 Mac 上的 Along 服务正在运行。若 Mac 地址变了，请到「编辑目标」更新地址后重试。":
                reason = "iPhone 无法连接 Mac。请确认 Mac 的 Along 服务在线，且手机能访问它。"
            case "iPhone 未能验证 Mac 的安全连接。若使用代理或 VPN，请允许 Along 直连局域网后重试。":
                reason = "iPhone 未能验证 Mac 的安全连接。请检查原配对和局域网连接。"
            default: return failureMessage
            }
        } else {
            let network = error as NSError
            guard network.domain == NSURLErrorDomain else { return failureMessage }
            switch URLError.Code(rawValue: network.code) {
            case .timedOut, .cannotConnectToHost, .cannotFindHost, .notConnectedToInternet, .networkConnectionLost:
                reason = "iPhone 无法连接 Mac。请确认 Mac 的 Along 服务在线，且手机能访问它。"
            default: return failureMessage
            }
        }
        switch self {
        case .refresh: return "本次刷新失败，仍显示上次同步的摘要。" + reason
        case .disconnect: return "断开失败，凭证尚未确认删除。" + reason
        case .connect, .status: return reason
        }
    }
}

private struct OKXConnectionSnapshot {
    let connected: Bool
    let lastSyncedAt: Date?
    let summary: OKXAccountSummary?

    init?(_ value: [String: Any]) {
        guard value["provider"] as? String == "okx",
              let state = value["state"] as? String,
              ["connected", "disconnected"].contains(state) else { return nil }
        connected = state == "connected"
        if connected {
            guard let rawDate = value["lastSyncedAt"] as? String,
                  let date = Self.date(rawDate),
                  let rawSummary = value["summary"] as? [String: Any],
                  let summary = OKXAccountSummary(rawSummary) else { return nil }
            lastSyncedAt = date
            self.summary = summary
        } else {
            lastSyncedAt = nil
            summary = nil
        }
    }

    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

private struct OKXAccountSummary {
    let equity: String
    let assetCount: Int
    let positionCount: Int

    init?(_ value: [String: Any]) {
        guard let rawEquity = value["tradingEquityUsd"] else { return nil }
        if let number = rawEquity as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
        let decimalText = String(describing: rawEquity)
        guard decimalText.range(of: #"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"#, options: .regularExpression) != nil,
              let amount = Decimal(string: decimalText, locale: Locale(identifier: "en_US_POSIX")),
              !amount.isNaN,
              let assetCount = Self.count(value["assetCount"]),
              let positionCount = Self.count(value["positionCount"]) else { return nil }
        let formatter = NumberFormatter()
        formatter.locale = .current
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        guard let formatted = formatter.string(from: amount as NSDecimalNumber) else { return nil }
        equity = formatted
        self.assetCount = assetCount
        self.positionCount = positionCount
    }

    private static func count(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue >= 0,
              number.doubleValue <= Double(Int.max),
              number.doubleValue.rounded() == number.doubleValue else { return nil }
        let count = number.intValue
        guard count >= 0, NSNumber(value: count).compare(number) == .orderedSame else { return nil }
        return count
    }
}
