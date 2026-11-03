import Foundation
import Security

struct AlongSyncClient {
    func pair(serviceURL: String, code: String) async throws -> String {
        let url = try endpoint(serviceURL, path: "/api/pair")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])
        let response = try await send(request)
        guard let token = response["token"] as? String, token.count == 64 else { throw SyncError.badResponse }
        return token
    }

    func sync(_ summary: HealthSummary, serviceURL: String, token: String) async throws {
        let url = try endpoint(serviceURL, path: "/api/health-sync")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: summary.syncPayload())
        let response = try await send(request)
        guard response["saved"] as? Bool == true else { throw SyncError.badResponse }
    }

    private func endpoint(_ text: String, path: String) throws -> URL {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let base = URLComponents(string: trimmed), base.scheme == "https", base.host != nil,
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil,
              base.path.isEmpty || base.path == "/" else { throw SyncError.httpsRequired }
        var target = base
        target.path = path
        guard let url = target.url else { throw SyncError.httpsRequired }
        return url
    }

    private func send(_ request: URLRequest) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw SyncError.badResponse }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(response.statusCode) else {
            throw SyncError.server(json["error"] as? String ?? "Along 服务返回了 \(response.statusCode)")
        }
        return json
    }
}

enum SyncError: LocalizedError {
    case httpsRequired, badResponse, server(String), noReadableData, missingPairCode
    var errorDescription: String? {
        switch self {
        case .httpsRequired: "请输入 Along 同步服务的 HTTPS 地址。"
        case .badResponse: "Along 服务返回了无法识别的结果。"
        case .server(let text): text
        case .noReadableData: "当前没有可读取的所选数据，因此没有发送任何内容。"
        case .missingPairCode: "请输入同步服务显示的一次性配对码。"
        }
    }
}

enum SyncTokenStore {
    private static let service = "com.artstur.AlongHealth.sync"

    static func read(for endpoint: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: endpoint,
                                    kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String, for endpoint: String) {
        let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                  kSecAttrService as String: service,
                                  kSecAttrAccount as String: endpoint]
        SecItemDelete(key as CFDictionary)
        var item = key
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }
}
