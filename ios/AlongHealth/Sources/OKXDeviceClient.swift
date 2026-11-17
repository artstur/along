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
    let permission = "read_only"
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
    private static let paths: Set<String> = ["/api/v5/public/time", "/api/v5/account/config", "/api/v5/account/balance", "/api/v5/account/positions"]

    init(transport: Transport? = nil, now: @escaping @Sendable () -> Date = { Date() },
         timeout: TimeInterval = 10, maxResponseBytes: Int = 512 * 1024) {
        self.transport = transport ?? { request, limit in
            try await OKXDeviceHTTPTransfer.perform(request: request, maxBytes: limit)
        }
        self.now = now
        self.timeout = timeout
        self.maxResponseBytes = maxResponseBytes
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
        guard capturedAt.timeIntervalSince1970.isFinite else { throw OKXDeviceClientError.invalidResponse }
        return OKXDeviceObservation(summary: OKXDeviceSummary(tradingEquityUsd: total, assetCount: currencies.count,
                                                             positionCount: positionCount), capturedAt: capturedAt)
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
                         offset: TimeInterval = 0) async throws -> [Any] {
        guard Self.paths.contains(path), timeout.isFinite, timeout > 0, timeout <= 30,
              (1...(2 * 1024 * 1024)).contains(maxResponseBytes), let url = URL(string: site.baseURL.absoluteString + path) else {
            throw OKXDeviceClientError.invalidResponse
        }
        try Self.checkCancellation()
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let credentials {
            let timestamp = try clock().addingTimeInterval(offset)
            let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let text = iso.string(from: timestamp)
            let prehash = text + "GET" + path
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
