import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const hasSwift = process.platform === 'darwin' && spawnSync('swiftc', ['--version']).status === 0;

test('native OKX device client signs fixed GETs, verifies actual permissions and bounds safe responses', {skip: !hasSwift}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'along-okx-device-client-'));
  try {
    const source = readFileSync(new URL('../ios/AlongHealth/Sources/OKXDeviceClient.swift', import.meta.url), 'utf8');
    const harness = join(directory, 'Check.swift');
    writeFileSync(harness, source + String.raw`

private let testNow = Date(timeIntervalSince1970: 1_795_000_000)
private let serverNow = testNow.addingTimeInterval(300)
private let testCredentials = OKXDeviceCredentials(apiKey: "synthetic-api-key", secretKey: "synthetic-secret", passphrase: "synthetic-passphrase")

private actor Fixture {
    let scenario: String
    var calls: [URLRequest] = []
    init(_ scenario: String = "ok") { self.scenario = scenario }
    func count() -> Int { calls.count }
    func handle(_ request: URLRequest, _ limit: Int) async throws -> (Data, HTTPURLResponse) {
        calls.append(request)
        let url = request.url!
        precondition(request.httpMethod == "GET" && request.httpBody == nil)
        precondition(["openapi.okx.com", "eea.okx.com", "us.okx.com"].contains(url.host!))
        precondition(url.scheme == "https" && url.query == nil && url.user == nil && url.password == nil)
        precondition(request.timeoutInterval > 0 && limit > 0)
        let path = url.path
        precondition(["/api/v5/public/time", "/api/v5/account/config", "/api/v5/account/balance", "/api/v5/account/positions"].contains(path))
        if path == "/api/v5/public/time" {
            for key in ["OK-ACCESS-KEY", "OK-ACCESS-SIGN", "OK-ACCESS-PASSPHRASE", "OK-ACCESS-TIMESTAMP", "Authorization", "Cookie"] {
                precondition(request.value(forHTTPHeaderField: key) == nil, "probe must not contain credentials")
            }
        } else {
            precondition(request.value(forHTTPHeaderField: "OK-ACCESS-KEY") == testCredentials.apiKey)
            precondition(request.value(forHTTPHeaderField: "OK-ACCESS-PASSPHRASE") == testCredentials.passphrase)
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let stamp = formatter.string(from: serverNow)
            precondition(request.value(forHTTPHeaderField: "OK-ACCESS-TIMESTAMP") == stamp, "private calls must use server-adjusted UTC time")
            let signature = HMAC<SHA256>.authenticationCode(for: Data((stamp + "GET" + path).utf8), using: SymmetricKey(data: Data(testCredentials.secretKey.utf8)))
            precondition(request.value(forHTTPHeaderField: "OK-ACCESS-SIGN") == Data(signature).base64EncodedString())
        }
        if scenario == "transport-secret" { throw NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: testCredentials.secretKey]) }
        if scenario == "timeout" { throw URLError(.timedOut, userInfo: [NSLocalizedDescriptionKey: testCredentials.passphrase]) }
        if scenario == "wait" { try await Task.sleep(nanoseconds: 5_000_000_000) }
        var rows: [Any]
        switch path {
        case "/api/v5/public/time":
            rows = [["ts": String(Int64(serverNow.timeIntervalSince1970 * 1000))]]
            if scenario == "time-number" { rows = [["ts": 1_795_000_300_000]] }
            if scenario == "time-invalid" { rows = [["ts": "not-a-time"]] }
        case "/api/v5/account/config":
            let permission = scenario.hasPrefix("perm:") ? String(scenario.dropFirst(5)) : "read_only"
            rows = [["perm": permission, "uid": "must-never-escape"]]
            if scenario == "missing-permission" { rows = [[:]] }
        case "/api/v5/account/balance":
            var total: Any = scenario == "zero" ? "0" : "1234.56"
            if scenario == "numeric-equity" { total = 1234.56 }
            if scenario == "missing-equity" { total = NSNull() }
            if scenario == "bad-equity" { total = "1garbage" }
            if scenario == "newline-equity" { total = "1\n" }
            if scenario == "nan-equity" { total = "NaN" }
            if scenario == "infinite-equity" { total = String(repeating: "9", count: 400) }
            var assets: [[String: Any]] = [["ccy": "USDT"], ["ccy": "BTC"]]
            if scenario == "duplicate-asset" { assets = [["ccy": "BTC"], ["ccy": "BTC"]] }
            if scenario == "invalid-asset" { assets = [["ccy": "btc"]] }
            if scenario == "missing-asset" { assets = [[:]] }
            rows = [["totalEq": total, "details": assets, "uid": "must-never-escape", "apiKey": testCredentials.apiKey]]
        case "/api/v5/account/positions":
            rows = [["pos": "1"], ["pos": "0"], ["pos": "-2"]]
            if scenario == "missing-position" { rows = [[:]] }
            if scenario == "numeric-position" { rows = [["pos": 1]] }
            if scenario == "unknown-position" { rows = [["pos": NSNull()]] }
            if scenario == "zero" { rows = [["pos": "0"]] }
        default: fatalError("unreachable endpoint")
        }
        var object: [String: Any] = ["code": scenario == "api-rejected" ? "50111" : "0", "data": rows, "msg": testCredentials.secretKey]
        if scenario == "wrong-data-shape" { object["data"] = ["not": "an-array"] }
        var data = try JSONSerialization.data(withJSONObject: object)
        if scenario == "oversize" { data = Data(repeating: 32, count: limit + 1) }
        if scenario == "malformed-json" { data = Data(testCredentials.secretKey.utf8) }
        let responseURL = scenario == "changed-url" ? URL(string: "https://untrusted.example/path")! : url
        let headers = scenario == "declared-oversize" ? ["Content-Length": String(limit + 1)] : ["Content-Type": "application/json"]
        return (data, HTTPURLResponse(url: responseURL, statusCode: scenario == "redirect-status" ? 302 : 200, httpVersion: nil, headerFields: headers)!)
    }
}

private func client(_ fixture: Fixture, maxBytes: Int = 512 * 1024) -> OKXDeviceClient {
    OKXDeviceClient(transport: { request, limit in try await fixture.handle(request, limit) }, now: { testNow }, maxResponseBytes: maxBytes)
}
private func expect(_ expected: OKXDeviceClientError, _ scenario: String) async {
    let fixture = Fixture(scenario)
    do {
        _ = try await client(fixture).collect(site: .global, credentials: testCredentials)
        fatalError("expected a closed failure for scenario \(scenario)")
    } catch {
        precondition(error as? OKXDeviceClientError == expected, "wrong safe error for scenario \(scenario)")
        let message = error.localizedDescription
        for secret in [testCredentials.apiKey, testCredentials.secretKey, testCredentials.passphrase] {
            precondition(!message.contains(secret), "upstream secrets cannot escape through error descriptions")
        }
    }
}

// Run the production streaming delegate using Foundation's isolated protocol
// fixture. The URL still targets the fixed official host; no socket is opened.
private final class StreamProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var mode = "valid"
    nonisolated(unsafe) static var followedRedirect = false
    override class func canInit(with request: URLRequest) -> Bool { ["openapi.okx.com", "untrusted.example"].contains(request.url?.host ?? "") }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.url?.host == "untrusted.example" {
            Self.followedRedirect = true
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        if Self.mode == "stall" { return }
        if Self.mode == "redirect" {
            let redirect = URLRequest(url: URL(string: "https://untrusted.example/credential-capture")!)
            let response = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: nil, headerFields: ["Location": redirect.url!.absoluteString])!
            client?.urlProtocol(self, wasRedirectedTo: redirect, redirectResponse: response)
            return
        }
        let headers = Self.mode == "declared" ? ["Content-Length": "4096"] : ["Content-Type": "application/json"]
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if Self.mode == "stream" {
            client?.urlProtocol(self, didLoad: Data(repeating: 32, count: 40))
            client?.urlProtocol(self, didLoad: Data(repeating: 32, count: 40))
        } else {
            client?.urlProtocol(self, didLoad: Data(#"{"code":"0","data":[{"ts":"1795000300000"}]}"#.utf8))
        }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main private struct Check {
    static func main() async throws {
        for site in OKXDeviceSite.allCases {
            let fixture = Fixture()
            let server = try await client(fixture).probe(site: site)
            precondition(server == serverNow)
            let count = await fixture.count(); precondition(count == 1)
            precondition(site.baseURL.scheme == "https" && site.settingsURL.scheme == "https")
        }
        let fixture = Fixture()
        let observation = try await client(fixture).collect(site: .eea, credentials: testCredentials)
        precondition(observation.permission == "read_only" && observation.capturedAt == serverNow)
        precondition(observation.summary == OKXDeviceSummary(tradingEquityUsd: 1234.56, assetCount: 2, positionCount: 2))
        let calls = await fixture.count(); precondition(calls == 4)
        let serialized = String(data: try JSONEncoder().encode(observation.summary), encoding: .utf8)!
        precondition(!serialized.contains("uid") && !serialized.contains(testCredentials.apiKey) && !serialized.contains("secret"))
        let zero = try await client(Fixture("zero")).collect(site: .us, credentials: testCredentials)
        precondition(zero.summary.tradingEquityUsd == 0 && zero.summary.positionCount == 0)
        for permission in ["trade", "read_only,trade", "read_only,withdraw", "read_only,unknown", "read_only "] {
            let scenario = Fixture("perm:" + permission)
            do { _ = try await client(scenario).collect(site: .global, credentials: testCredentials); fatalError("permission must be refused") }
            catch { precondition(error as? OKXDeviceClientError == .permissionDenied) }
            let count = await scenario.count(); precondition(count == 2, "must stop before private balance reads")
        }
        await expect(.permissionDenied, "missing-permission")
        for scenario in ["time-number", "time-invalid", "numeric-equity", "missing-equity", "bad-equity", "newline-equity", "nan-equity", "infinite-equity", "duplicate-asset", "invalid-asset", "missing-asset", "missing-position", "numeric-position", "unknown-position", "wrong-data-shape", "oversize", "declared-oversize", "malformed-json", "changed-url"] {
            await expect(.invalidResponse, scenario)
        }
        await expect(.apiRejected, "api-rejected")
        await expect(.apiRejected, "redirect-status")
        await expect(.networkError, "transport-secret")
        await expect(.timeout, "timeout")
        for bad in ["", "has space", "has\r\ninjection", String(repeating: "x", count: 257)] {
            let fixture = Fixture()
            do {
                _ = try await client(fixture).collect(site: .global, credentials: OKXDeviceCredentials(apiKey: bad, secretKey: "synthetic", passphrase: "synthetic"))
                fatalError("bad credentials must fail before transport")
            } catch { precondition(error as? OKXDeviceClientError == .invalidCredentials) }
            let count = await fixture.count(); precondition(count == 0)
        }
        let waiting = client(Fixture("wait"))
        let pending = Task { try await waiting.collect(site: .global, credentials: testCredentials) }
        try await Task.sleep(nanoseconds: 10_000_000)
        pending.cancel()
        do { _ = try await pending.value; fatalError("cancelled read must not succeed") }
        catch { precondition(error as? OKXDeviceClientError == .cancelled) }
        print("fixed sites, HMAC, clock correction, readonly permissions, scalar summaries and safe failures passed")

        var request = URLRequest(url: OKXDeviceSite.global.baseURL.appendingPathComponent("api/v5/public/time"))
        request.httpMethod = "GET"; request.timeoutInterval = 1
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StreamProtocol.self]
        StreamProtocol.mode = "valid"
        let (data, response) = try await OKXDeviceHTTPTransfer.perform(request: request, maxBytes: 64, configuration: configuration)
        precondition(data.count < 64 && response.statusCode == 200)
        for mode in ["stream", "declared"] {
            StreamProtocol.mode = mode
            do { _ = try await OKXDeviceHTTPTransfer.perform(request: request, maxBytes: 64, configuration: configuration); fatalError("oversize transfer must fail") }
            catch { precondition(error as? OKXDeviceClientError == .invalidResponse) }
        }
        StreamProtocol.mode = "redirect"
        do { _ = try await OKXDeviceHTTPTransfer.perform(request: request, maxBytes: 64, configuration: configuration); fatalError("redirect must be refused") }
        catch { precondition(error as? OKXDeviceClientError == .invalidResponse) }
        precondition(!StreamProtocol.followedRedirect, "redirect destination must never be requested")
        StreamProtocol.mode = "stall"
        request.timeoutInterval = 0.1
        let deadline = Task { try await OKXDeviceHTTPTransfer.perform(request: request, maxBytes: 64, configuration: configuration) }
        let watchdog = Task {
            try await Task.sleep(nanoseconds: 2_000_000_000)
            deadline.cancel()
        }
        do { _ = try await deadline.value; fatalError("stalled transfer must time out") }
        catch { precondition(error as? OKXDeviceClientError == .timeout, "URLSession resource timeout must finish before watchdog") }
        watchdog.cancel()
        request.timeoutInterval = 1
        let streaming = Task { try await OKXDeviceHTTPTransfer.perform(request: request, maxBytes: 64, configuration: configuration) }
        try await Task.sleep(nanoseconds: 10_000_000)
        streaming.cancel()
        do { _ = try await streaming.value; fatalError("cancelled stream must not succeed") }
        catch { precondition(error as? OKXDeviceClientError == .cancelled) }
        print("actual streaming transfer enforces declared and incremental body limits, redirects, timeout and cancellation")
    }
}
`);
    const executable = join(directory, 'check');
    execFileSync('swiftc', ['-swift-version', '5', '-parse-as-library', '-module-cache-path', join(directory, 'module-cache'), harness, '-o', executable], {timeout: 90000, maxBuffer: 2_000_000});
    const output = execFileSync(executable, {encoding: 'utf8', timeout: 20000, maxBuffer: 2_000_000});
    assert.match(output, /readonly permissions, scalar summaries and safe failures passed/);
    assert.match(output, /actual streaming transfer enforces declared and incremental body limits, redirects, timeout and cancellation/);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
