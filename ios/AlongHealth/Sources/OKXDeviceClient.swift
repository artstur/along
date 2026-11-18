import Foundation
import CryptoKit

enum OKXDeviceSite: String, Codable, CaseIterable, Identifiable, Sendable {
    case global, eea, us
    var id: String { rawValue }
    var title: String {
        switch self {
        case .global: "Global · www.okx.com"
        case .eea: "EEA · my.okx.com"
        case .us: "US · app.okx.com"
        }
    }
    var baseURL: URL {
        switch self {
        case .global: URL(string: "https://openapi.okx.com")!
        case .eea: URL(string: "https://eea.okx.com")!
        case .us: URL(string: "https://us.okx.com")!
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

struct OKXDeviceCredentials: Codable, Sendable {
    let apiKey: String
    let secretKey: String
    let passphrase: String
}

struct OKXDeviceSummary: Codable, Equatable, Sendable {
    let tradingEquityUsd: Double
    let assetCount: Int
    let positionCount: Int
}

struct OKXDeviceObservation: Equatable, Sendable {
    let summary: OKXDeviceSummary
    let capturedAt: Date
    let history: OKXDeviceHistory?
    init(summary: OKXDeviceSummary, capturedAt: Date, history: OKXDeviceHistory? = nil) {
        self.summary = summary; self.capturedAt = capturedAt; self.history = history
    }
    let permission = "read_only"
}

/// Normalized private rows. Decimal and identifier text never passes through Double.
struct OKXDeviceHistory: Codable, Equatable, Sendable {
    struct Stream: Codable, Equatable, Sendable {
        let kind: String
        let instType: String
        var status: String
        var reason: String
        let pages: Int
    }
    let version: Int
    let windowStart: String
    let windowEnd: String
    var streams: [Stream]
    var fills: [[String: String]]
    var bills: [[String: String]]
    static let types = ["SPOT", "MARGIN", "SWAP", "FUTURES", "OPTION", "EVENTS"]
    static let fillKeys: Set<String> = ["billId", "tradeId", "ordId", "instType", "instId", "side", "posSide", "fillPx", "fillSz", "fillPnl", "fee", "feeCcy", "ts", "tag"]
    static let billKeys: Set<String> = ["billId", "instType", "instId", "type", "subType", "ccy", "pnl", "fee", "balChg", "sz", "px", "ts"]
    static func matches(_ text: String, _ pattern: String, max: Int) -> Bool {
        text.utf8.count <= max && text.range(of: pattern, options: .regularExpression) == text.startIndex..<text.endIndex
    }
    static func date(_ text: String) -> Date? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
    static func decimal(_ text: String) -> Bool { text.isEmpty || matches(text, #"^-?[0-9]{1,36}(?:\.[0-9]{1,24})?$"#, max: 64) }
    static func row(_ row: [String: String], kind: String, start: Int64, end: Int64) -> Bool {
        let fill = kind == "fills"
        guard Set(row.keys) == (fill ? fillKeys : billKeys), let bill = row["billId"], matches(bill, #"^[0-9]+$"#, max: 64),
              let ts = row["ts"], matches(ts, #"^[0-9]{13}$"#, max: 13), let ms = Int64(ts), ms >= start && ms <= end,
              let inst = row["instId"], matches(inst, fill ? #"^[A-Z0-9_-]+$"# : #"^[A-Z0-9_-]*$"#, max: 80),
              let type = row["instType"], types.contains(type) || !fill && type.isEmpty else { return false }
        let numeric = fill ? ["fillPx", "fillSz", "fillPnl", "fee"] : ["pnl", "fee", "balChg", "sz", "px"]
        guard numeric.allSatisfy({ row[$0].map(decimal) == true }), !fill || !["fillPx", "fillSz"].contains(where: { row[$0]?.hasPrefix("-") == true }) else { return false }
        let ccy = row[fill ? "feeCcy" : "ccy"] ?? ""
        guard matches(ccy, fill ? #"^[A-Z0-9]*$"# : #"^[A-Z0-9]+$"#, max: 24) else { return false }
        if fill {
            let trade = row["tradeId"] ?? ""
            return (trade.isEmpty || matches(trade, #"^-?[0-9]+$"#, max: trade.hasPrefix("-") ? 65 : 64)) && matches(row["ordId"] ?? "", #"^[0-9]*$"#, max: 64) &&
                ["buy", "sell"].contains(row["side"] ?? "") && ["", "long", "short", "net"].contains(row["posSide"] ?? "") &&
                matches(row["tag"] ?? "", #"^[A-Za-z0-9_-]*$"#, max: 32)
        }
        return matches(row["type"] ?? "", #"^[0-9]+$"#, max: 4) && matches(row["subType"] ?? "", #"^[0-9]*$"#, max: 4)
    }
    func dictionary() throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as? [String: Any] else { throw OKXDeviceClientError.invalidResponse }
        return value
    }
    static func decode(_ value: Any) -> OKXDeviceHistory? {
        guard let obj = value as? [String: Any], Set(obj.keys) == ["version", "windowStart", "windowEnd", "streams", "fills", "bills"],
              let data = try? JSONSerialization.data(withJSONObject: obj), data.count <= 2 * 1024 * 1024,
              let h = try? JSONDecoder().decode(Self.self, from: data), h.version == 1,
              let startDate = date(h.windowStart), let endDate = date(h.windowEnd), endDate > startDate,
              endDate.timeIntervalSince(startDate) <= 90 * 86400 + 0.001, h.streams.count == 7,
              h.fills.count <= 3000, h.bills.count <= 2000 else { return nil }
        let expected = Set(types.map { "fills:" + $0 } + ["bills:ALL"])
        guard Set(h.streams.map { $0.kind + ":" + $0.instType }) == expected,
              let rawStreams = obj["streams"] as? [[String: Any]], rawStreams.allSatisfy({ Set($0.keys) == ["kind", "instType", "status", "reason", "pages"] }),
              h.streams.allSatisfy({ stream in
                  stream.pages >= 0 && stream.pages <= (stream.kind == "fills" ? 5 : 20) &&
                  (stream.status == "complete" && stream.reason == "none" || stream.status == "truncated" && stream.reason == "page_limit" || stream.status == "unavailable" && stream.reason == "api_unavailable")
              }) else { return nil }
        let start = Int64((startDate.timeIntervalSince1970 * 1000).rounded()), end = Int64((endDate.timeIntervalSince1970 * 1000).rounded())
        guard h.streams.allSatisfy({ stream in
            let count = stream.kind == "fills" ? h.fills.filter { $0["instType"] == stream.instType }.count : h.bills.count
            return count <= stream.pages * 100 && (stream.status == "unavailable" || stream.pages > 0) && (stream.kind != "fills" || count <= 500)
        }) else { return nil }
        guard h.fills.allSatisfy({ row($0, kind: "fills", start: start, end: end) }),
              h.bills.allSatisfy({ row($0, kind: "bills", start: start, end: end) }),
              Set(h.fills.compactMap { $0["billId"] }).count == h.fills.count,
              Set(h.bills.compactMap { $0["billId"] }).count == h.bills.count else { return nil }
        return h
    }
}

/// Closed error vocabulary: neither upstream bodies nor transport descriptions
/// (which may contain credential headers) are safe to expose to callers.
enum OKXDeviceClientError: String, LocalizedError, Sendable {
    case invalidCredentials, permissionDenied, apiRejected, networkError, timeout, invalidResponse, cancelled

    var errorDescription: String? {
        switch self {
        case .invalidCredentials: "请完整填写 OKX 只读 API 凭证。"
        case .permissionDenied: "仅支持只读 API Key，请关闭交易和提现权限后重试。"
        case .apiRejected: "OKX 未接受请求，请检查凭证、所属站点及 IP 白名单。"
        case .networkError: "iPhone 暂时无法连接 OKX，请检查手机网络后重试。"
        case .timeout: "iPhone 请求 OKX 超时，请检查手机网络后重试。"
        case .invalidResponse: "OKX 返回的数据无法验证，请稍后重试。"
        case .cancelled: "已取消 OKX 读取。"
        }
    }

    fileprivate static func safe(_ error: Error) -> Self {
        if let safe = error as? Self { return safe }
        if error is CancellationError { return .cancelled }
        let cause = error as NSError
        if cause.domain == NSURLErrorDomain {
            if cause.code == URLError.timedOut.rawValue { return .timeout }
            if cause.code == URLError.cancelled.rawValue { return .cancelled }
        }
        return .networkError
    }
}

/// A fixed, read-only provider. The injectable transport is for isolated tests;
/// production uses system TLS and the phone's normal network configuration.
actor OKXDeviceClient {
    typealias Transport = @Sendable (URLRequest, Int) async throws -> (Data, HTTPURLResponse)
    private let transport: Transport
    private let now: @Sendable () -> Date
    private let timeout: TimeInterval
    private let maxResponseBytes: Int
    private let includeHistory: Bool
    private let historyDelayNanoseconds: UInt64
    private static let paths: Set<String> = ["/api/v5/public/time", "/api/v5/account/config", "/api/v5/account/balance", "/api/v5/account/positions", "/api/v5/trade/fills-history", "/api/v5/account/bills-archive"]

    init(transport: Transport? = nil, now: @escaping @Sendable () -> Date = { Date() },
         timeout: TimeInterval = 10, maxResponseBytes: Int = 512 * 1024, includeHistory: Bool = true, historyDelayNanoseconds: UInt64 = 450_000_000) {
        self.transport = transport ?? { request, limit in
            try await OKXDeviceHTTPTransfer.perform(request: request, maxBytes: limit)
        }
        self.now = now
        self.timeout = timeout
        self.maxResponseBytes = maxResponseBytes
        self.includeHistory = includeHistory
        self.historyDelayNanoseconds = historyDelayNanoseconds
    }

    /// No credential is read, loaded, or attached to this public request.
    func probe(site: OKXDeviceSite) async throws -> Date {
        try await calibration(site: site).serverTime
    }

    func collect(site: OKXDeviceSite, credentials: OKXDeviceCredentials) async throws -> OKXDeviceObservation {
        guard [credentials.apiKey, credentials.secretKey, credentials.passphrase].allSatisfy(Self.validCredential) else {
            throw OKXDeviceClientError.invalidCredentials
        }
        let offset = try await calibration(site: site).offset
        let config = try await request(site: site, path: "/api/v5/account/config", credentials: credentials, offset: offset)
        guard config.count == 1, let configuration = config.first as? [String: Any] else { throw OKXDeviceClientError.invalidResponse }
        guard configuration["perm"] as? String == "read_only" else { throw OKXDeviceClientError.permissionDenied }
        let balance = try await request(site: site, path: "/api/v5/account/balance", credentials: credentials, offset: offset)
        guard balance.count == 1, let account = balance.first as? [String: Any],
              let total = Self.decimal(account["totalEq"]), let assets = account["details"] as? [[String: Any]] else {
            throw OKXDeviceClientError.invalidResponse
        }
        var currencies = Set<String>()
        for asset in assets {
            guard let currency = asset["ccy"] as? String, (1...24).contains(currency.utf8.count),
                  currency.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) }),
                  currencies.insert(currency).inserted else { throw OKXDeviceClientError.invalidResponse }
        }
        let positions = try await request(site: site, path: "/api/v5/account/positions", credentials: credentials, offset: offset)
        var positionCount = 0
        for value in positions {
            guard let position = value as? [String: Any], let amount = Self.decimal(position["pos"]) else {
                throw OKXDeviceClientError.invalidResponse
            }
            if amount != 0 { positionCount += 1 }
        }
        try Self.checkCancellation()
        let capturedAt = try clock().addingTimeInterval(offset)
        let history = includeHistory ? try await collectHistory(site: site, credentials: credentials, offset: offset, endDate: capturedAt) : nil
        guard capturedAt.timeIntervalSince1970.isFinite else { throw OKXDeviceClientError.invalidResponse }
        return OKXDeviceObservation(summary: OKXDeviceSummary(tradingEquityUsd: total, assetCount: currencies.count,
                                                             positionCount: positionCount), capturedAt: capturedAt, history: history)
    }

    private func collectHistory(site: OKXDeviceSite, credentials: OKXDeviceCredentials, offset: TimeInterval, endDate: Date) async throws -> OKXDeviceHistory {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        guard let threeMonths = calendar.date(byAdding: .month, value: -3, to: endDate) else { throw OKXDeviceClientError.invalidResponse }
        let startDate = max(threeMonths, endDate.addingTimeInterval(-90 * 86400))
        let start = Int64((startDate.timeIntervalSince1970 * 1000).rounded()), end = Int64((endDate.timeIntervalSince1970 * 1000).rounded())
        func iso(_ date: Date) -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: date) }
        var history = OKXDeviceHistory(version: 1, windowStart: iso(Date(timeIntervalSince1970: Double(start) / 1000)), windowEnd: iso(Date(timeIntervalSince1970: Double(end) / 1000)), streams: [], fills: [], bills: [])
        var allFillIDs = Set<String>()
        for (kind, type) in OKXDeviceHistory.types.map({ ("fills", $0) }) + [("bills", "ALL")] {
            var rows: [[String: String]] = [], seenRows: [String: [String: String]] = [:], cursor: String?, pages = 0
            var status = "truncated", reason = "page_limit"
            let pageLimit = kind == "fills" ? 5 : 20
            do {
                for _ in 0..<pageLimit {
                    try Self.checkCancellation()
                    if historyDelayNanoseconds > 0 { try await Task.sleep(nanoseconds: historyDelayNanoseconds) }
                    var query = [URLQueryItem(name: "begin", value: String(start)), URLQueryItem(name: "end", value: String(end)), URLQueryItem(name: "limit", value: "100")]
                    if kind == "fills" { query.append(URLQueryItem(name: "instType", value: type)) }
                    if let cursor { query.append(URLQueryItem(name: "after", value: cursor)) }
                    let result = try await request(site: site, path: kind == "fills" ? "/api/v5/trade/fills-history" : "/api/v5/account/bills-archive", credentials: credentials, offset: offset, query: query)
                    pages += 1
                    guard result.count <= 100 else { throw OKXDeviceClientError.invalidResponse }
                    var previous = cursor
                    for value in result {
                        guard let raw = value as? [String: Any] else { throw OKXDeviceClientError.invalidResponse }
                        let keys = kind == "fills" ? OKXDeviceHistory.fillKeys : OKXDeviceHistory.billKeys
                        var row: [String: String] = [:]
                        for key in keys {
                            if let text = raw[key] as? String { row[key] = text }
                            else if raw[key] == nil && ["tradeId", "ordId", "posSide", "tag", "pnl", "fee", "fillPnl", "fillPx", "fillSz", "feeCcy", "sz", "px", "balChg", "instType", "instId", "subType"].contains(key) { row[key] = "" }
                            else { throw OKXDeviceClientError.invalidResponse }
                        }
                        guard OKXDeviceHistory.row(row, kind: kind, start: start, end: end), kind != "fills" || row["instType"] == type, let id = row["billId"] else { throw OKXDeviceClientError.invalidResponse }
                        if let previous, id != previous && !Self.older(id, than: previous) { throw OKXDeviceClientError.invalidResponse }
                        if let cursor, id == cursor { throw OKXDeviceClientError.invalidResponse }
                        previous = id
                        if let previousRow = seenRows[id] {
                            guard previousRow == row else { throw OKXDeviceClientError.invalidResponse }
                        } else {
                            if kind == "fills", !allFillIDs.insert(id).inserted { throw OKXDeviceClientError.invalidResponse }
                            seenRows[id] = row; rows.append(row)
                        }
                    }
                    if result.count < 100 { status = "complete"; reason = "none"; break }
                    guard let next = previous, cursor == nil || Self.older(next, than: cursor!) else { throw OKXDeviceClientError.invalidResponse }
                    cursor = next
                }
            } catch {
                if Task.isCancelled || error is CancellationError || error as? OKXDeviceClientError == .cancelled { throw OKXDeviceClientError.cancelled }
                status = "unavailable"; reason = "api_unavailable"
            }
            history.streams.append(.init(kind: kind, instType: type, status: status, reason: reason, pages: pages))
            if kind == "fills" { history.fills += rows } else { history.bills += rows }
        }
        // Keep bounded normalized evidence even when many maximal-length rows hit the byte budget.
        while (try JSONEncoder().encode(history)).count > 2 * 1024 * 1024 {
            if !history.bills.isEmpty {
                history.bills.removeLast(min(100, history.bills.count))
                let i = history.streams.count - 1
                if history.streams[i].status != "unavailable" { history.streams[i].status = "truncated"; history.streams[i].reason = "page_limit" }
            } else if !history.fills.isEmpty {
                let removed = history.fills.suffix(min(100, history.fills.count))
                for type in Set(removed.compactMap { $0["instType"] }) {
                    if let i = history.streams.firstIndex(where: { $0.kind == "fills" && $0.instType == type }), history.streams[i].status != "unavailable" { history.streams[i].status = "truncated"; history.streams[i].reason = "page_limit" }
                }
                history.fills.removeLast(removed.count)
            } else { throw OKXDeviceClientError.invalidResponse }
        }
        return history
    }
    private static func older(_ lhs: String, than rhs: String) -> Bool {
        let a = String(lhs.drop(while: { $0 == "0" })), b = String(rhs.drop(while: { $0 == "0" }))
        return a.count == b.count ? a < b : a.count < b.count
    }

    private func calibration(site: OKXDeviceSite) async throws -> (serverTime: Date, offset: TimeInterval) {
        let start = try clock()
        let rows = try await request(site: site, path: "/api/v5/public/time")
        let end = try clock()
        guard rows.count == 1, let row = rows.first as? [String: Any], let text = row["ts"] as? String,
              text.utf8.count == 13, text.utf8.allSatisfy({ (48...57).contains($0) }), let milliseconds = Double(text),
              end >= start else { throw OKXDeviceClientError.invalidResponse }
        let serverTime = Date(timeIntervalSince1970: milliseconds / 1000)
        let midpoint = start.addingTimeInterval(end.timeIntervalSince(start) / 2)
        return (serverTime, serverTime.timeIntervalSince(midpoint))
    }

    private func clock() throws -> Date {
        let value = now()
        guard value.timeIntervalSince1970.isFinite else { throw OKXDeviceClientError.invalidResponse }
        return value
    }

    private func request(site: OKXDeviceSite, path: String, credentials: OKXDeviceCredentials? = nil,
                         offset: TimeInterval = 0, query: [URLQueryItem] = []) async throws -> [Any] {
        guard Self.paths.contains(path), timeout.isFinite, timeout > 0, timeout <= 30,
              (1...(2 * 1024 * 1024)).contains(maxResponseBytes),
              query.allSatisfy({ ["begin", "end", "limit", "instType", "after"].contains($0.name) && $0.value != nil }),
              query.isEmpty || ["/api/v5/trade/fills-history", "/api/v5/account/bills-archive"].contains(path),
              var components = URLComponents(string: site.baseURL.absoluteString + path) else {
            throw OKXDeviceClientError.invalidResponse
        }
        components.queryItems = query.isEmpty ? nil : query.sorted { $0.name < $1.name }
        guard let url = components.url else { throw OKXDeviceClientError.invalidResponse }
        let target = path + (components.percentEncodedQuery.map { "?" + $0 } ?? "")
        try Self.checkCancellation()
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let credentials {
            let timestamp = try clock().addingTimeInterval(offset)
            let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let text = iso.string(from: timestamp)
            let prehash = text + "GET" + target
            let signature = HMAC<SHA256>.authenticationCode(for: Data(prehash.utf8), using: SymmetricKey(data: Data(credentials.secretKey.utf8)))
            request.setValue(credentials.apiKey, forHTTPHeaderField: "OK-ACCESS-KEY")
            request.setValue(credentials.passphrase, forHTTPHeaderField: "OK-ACCESS-PASSPHRASE")
            request.setValue(text, forHTTPHeaderField: "OK-ACCESS-TIMESTAMP")
            request.setValue(Data(signature).base64EncodedString(), forHTTPHeaderField: "OK-ACCESS-SIGN")
        }
        let data: Data, response: HTTPURLResponse
        do { (data, response) = try await transport(request, maxResponseBytes) }
        catch { throw OKXDeviceClientError.safe(error) }
        try Self.checkCancellation()
        guard response.url == url else { throw OKXDeviceClientError.invalidResponse }
        guard (200...299).contains(response.statusCode) else { throw OKXDeviceClientError.apiRejected }
        guard data.count <= maxResponseBytes else { throw OKXDeviceClientError.invalidResponse }
        if let declared = response.value(forHTTPHeaderField: "Content-Length") {
            guard !declared.isEmpty, declared.utf8.allSatisfy({ (48...57).contains($0) }),
                  let count = Int(declared), count <= maxResponseBytes else { throw OKXDeviceClientError.invalidResponse }
        }
        let value: Any
        do { value = try JSONSerialization.jsonObject(with: data) }
        catch { throw OKXDeviceClientError.invalidResponse }
        guard let result = value as? [String: Any], let code = result["code"] as? String else { throw OKXDeviceClientError.invalidResponse }
        guard code == "0" else { throw OKXDeviceClientError.apiRejected }
        guard let rows = result["data"] as? [Any] else { throw OKXDeviceClientError.invalidResponse }
        return rows
    }

    private static func validCredential(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 256 && value.unicodeScalars.allSatisfy {
            !CharacterSet.whitespacesAndNewlines.contains($0) && !CharacterSet.controlCharacters.contains($0)
        }
    }

    private static func decimal(_ value: Any?) -> Double? {
        guard let text = value as? String,
              text.range(of: #"^-?[0-9]+(?:\.[0-9]+)?$"#, options: .regularExpression) == text.startIndex..<text.endIndex,
              let amount = Double(text), amount.isFinite else { return nil }
        return amount
    }

    private static func checkCancellation() throws {
        if Task.isCancelled { throw OKXDeviceClientError.cancelled }
    }
}

/// A bounded streaming transfer. No challenge override is installed: HTTPS uses
/// normal system certificate validation. Redirects are rejected before following.
private final class OKXDeviceHTTPTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let request: URLRequest
    private let maxBytes: Int
    private var continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var received = Data()
    private var response: HTTPURLResponse?
    private var cancelled = false
    private var finished = false

    private init(request: URLRequest, maxBytes: Int) { self.request = request; self.maxBytes = maxBytes }

    static func perform(request: URLRequest, maxBytes: Int, configuration: URLSessionConfiguration = .ephemeral) async throws -> (Data, HTTPURLResponse) {
        let transfer = OKXDeviceHTTPTransfer(request: request, maxBytes: maxBytes)
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = request.timeoutInterval
        configuration.timeoutIntervalForResource = request.timeoutInterval
        // Keep system proxy/VPN behaviour; the private Mac's DIRECT override is not appropriate for OKX.
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { transfer.start($0, configuration: configuration) }
        } onCancel: { transfer.cancel() }
    }

    private func start(_ continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>, configuration: URLSessionConfiguration) {
        lock.lock()
        if cancelled { lock.unlock(); continuation.resume(throwing: OKXDeviceClientError.cancelled); return }
        self.continuation = continuation
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        self.session = session
        let task = session.dataTask(with: request); self.task = task
        lock.unlock()
        task.resume()
    }

    private func cancel() {
        lock.lock(); cancelled = true; let started = continuation != nil; lock.unlock()
        if started { finish(.failure(OKXDeviceClientError.cancelled)) }
    }

    private func finish(_ result: Result<(Data, HTTPURLResponse), Error>) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let continuation = continuation, session = session, task = task
        self.continuation = nil; self.session = nil; self.task = nil
        lock.unlock()
        task?.cancel()
        session?.invalidateAndCancel()
        continuation?.resume(with: result)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        finish(.failure(OKXDeviceClientError.invalidResponse))
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, http.url == request.url else {
            completionHandler(.cancel); finish(.failure(OKXDeviceClientError.invalidResponse)); return
        }
        guard (200...299).contains(http.statusCode) else {
            completionHandler(.cancel); finish(.failure(OKXDeviceClientError.apiRejected)); return
        }
        guard response.expectedContentLength <= Int64(maxBytes) else {
            completionHandler(.cancel); finish(.failure(OKXDeviceClientError.invalidResponse)); return
        }
        lock.lock(); self.response = http; let active = !finished; lock.unlock()
        completionHandler(active ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        guard data.count <= maxBytes - received.count else {
            lock.unlock(); finish(.failure(OKXDeviceClientError.invalidResponse)); return
        }
        received.append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(.failure(OKXDeviceClientError.safe(error))); return }
        lock.lock(); let response = response, data = received; lock.unlock()
        guard let response else { finish(.failure(OKXDeviceClientError.invalidResponse)); return }
        finish(.success((data, response)))
    }
}
