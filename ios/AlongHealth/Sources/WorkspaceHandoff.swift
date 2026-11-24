import Foundation
import CryptoKit
import Security

enum WorkspaceHandoffError: Error { case invalidProof, invalidState, secretUnavailable }

// The original Host signs fixed, strictly ASCII fields. The certificate must match the pin
// already held by this phone; neither JavaScript nor a new public CA can claim that identity.
enum WorkspaceHandoffProof {
    static let purpose = "along-personal-workspace-handoff/v1"
    static let fields = ["purpose", "migrationId", "sourceOrigin", "targetOrigin", "userId", "deviceId",
        "sourceCredentialSHA256", "targetCredentialSHA256", "manifestSHA256", "importReceiptSHA256", "snapshotSHA256", "syncPrefixSHA256",
        "syncHighWaterMark", "activationPermitSHA256", "sourcePhase", "nonce", "issuedAt", "expiresAt"]
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func hash(_ text: String) -> String { hash(Data(text.utf8)) }
    static func isHash(_ text: String?) -> Bool { text?.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
    static func origin(_ text: String) -> String? {
        guard let c = URLComponents(string: text), c.scheme == "https", let host = c.host,
              c.user == nil, c.password == nil, c.path.isEmpty, c.query == nil, c.fragment == nil,
              host.utf8.allSatisfy({ $0 > 32 && $0 < 127 }), !host.contains(":"),
              c.port.map({ (1...65535).contains($0) }) ?? true else { return nil }
        return "https://" + host.lowercased() + (c.port.map { $0 == 443 ? "" : ":\($0)" } ?? "")
    }
    static func claims(_ proof: [String: Any], now: Date = Date(), allowExpired: Bool = false) throws -> [String: String] {
        guard Set(proof.keys) == ["algorithm", "payload", "certificateDER", "signature"],
              proof["algorithm"] as? String == "rsa-pkcs1-sha256",
              let payload = proof["payload"] as? String, payload.utf8.count < 8192 else { throw WorkspaceHandoffError.invalidProof }
        let lines = payload.components(separatedBy: "\n")
        guard lines.count == fields.count + 1, lines.last == "" else { throw WorkspaceHandoffError.invalidProof }
        var c: [String: String] = [:]
        for (index, key) in fields.enumerated() {
            let prefix = key + "="
            guard lines[index].hasPrefix(prefix) else { throw WorkspaceHandoffError.invalidProof }
            c[key] = String(lines[index].dropFirst(prefix.count))
        }
        guard Set(c.keys) == Set(fields),
              c.values.allSatisfy({ !$0.isEmpty && $0.count <= 250 && $0.utf8.allSatisfy { $0 > 32 && $0 < 127 } }),
              c["purpose"] == purpose, c["sourcePhase"] == "source_retired",
              c["migrationId"]!.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$", options: .regularExpression) != nil,
              c["userId"]!.range(of: "^u_[0-9a-f]{8}$", options: .regularExpression) != nil,
              c["deviceId"]!.range(of: "^d_[0-9a-f]{8}$", options: .regularExpression) != nil,
              ["sourceCredentialSHA256", "targetCredentialSHA256", "manifestSHA256", "importReceiptSHA256", "snapshotSHA256", "syncPrefixSHA256", "activationPermitSHA256", "nonce"].allSatisfy({ isHash(c[$0]) }),
              let high = UInt64(c["syncHighWaterMark"]!), high <= 9_007_199_254_740_991, String(high) == c["syncHighWaterMark"],
              let issued = UInt64(c["issuedAt"]!), let expires = UInt64(c["expiresAt"]!),
              String(issued) == c["issuedAt"], String(expires) == c["expiresAt"],
              issued >= 100_000_000, issued <= 99_999_999_999, expires <= 99_999_999_999,
              expires > issued, expires - issued <= 900, Double(issued) <= now.timeIntervalSince1970 + 30,
              allowExpired || Double(expires) > now.timeIntervalSince1970,
              origin(c["sourceOrigin"]!) == c["sourceOrigin"], origin(c["targetOrigin"]!) == c["targetOrigin"],
              c["sourceOrigin"] != c["targetOrigin"], c["sourceCredentialSHA256"] != c["targetCredentialSHA256"] else { throw WorkspaceHandoffError.invalidProof }
        return c
    }
    static func verifySignature(_ proof: [String: Any], sourcePin: String, now: Date = Date(), allowExpired: Bool = false) throws -> [String: String] {
        guard let payload = proof["payload"] as? String, payload.utf8.count < 8192,
              let certText = proof["certificateDER"] as? String, certText.count < 16_384,
              let der = Data(base64Encoded: certText), der.base64EncodedString() == certText,
              hash(der).uppercased() == sourcePin.uppercased(),
              let cert = SecCertificateCreateWithData(nil, der as CFData), let key = SecCertificateCopyKey(cert),
              SecKeyIsAlgorithmSupported(key, .verify, .rsaSignatureMessagePKCS1v15SHA256),
              let signatureText = proof["signature"] as? String, signatureText.count < 4096,
              let signature = Data(base64Encoded: signatureText), signature.base64EncodedString() == signatureText else { throw WorkspaceHandoffError.invalidProof }
        // Verify exactly the original UTF8 string bytes. Parsing comes afterwards; neither
        // slash escaping nor Foundation's JSON/key ordering participates in verification.
        let bytes = Data(payload.utf8)
        guard SecKeyVerifySignature(key, .rsaSignatureMessagePKCS1v15SHA256, bytes as CFData, signature as CFData, nil) else {
            throw WorkspaceHandoffError.invalidProof
        }
        return try claims(proof, now: now, allowExpired: allowExpired)
    }
    static func manifest(_ text: String, claims c: [String: String]) throws -> [String: Any] {
        let expected: Set<String> = ["format", "migrationId", "sourceUserId", "sourceDeviceId", "schemaVersion", "targetOrigin", "createdAt", "goalIds",
            "snapshotSHA256", "syncPrefixSHA256", "syncHighWaterMark", "activationPermitSHA256", "hostCompanionSHA256", "sourceHolds", "tables"]
        guard text.utf8.count <= 128 * 1024, hash(text) == c["manifestSHA256"],
              let m = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], Set(m.keys) == expected,
              m["format"] as? String == "along-personal-handoff/v1", m["migrationId"] as? String == c["migrationId"],
              m["sourceUserId"] as? String == c["userId"], m["sourceDeviceId"] as? String == c["deviceId"],
              m["targetOrigin"] as? String == c["targetOrigin"], m["schemaVersion"] as? Int == 18,
              m["snapshotSHA256"] as? String == c["snapshotSHA256"], m["syncPrefixSHA256"] as? String == c["syncPrefixSHA256"],
              m["activationPermitSHA256"] as? String == c["activationPermitSHA256"],
              isHash(m["hostCompanionSHA256"] as? String),
              let high = safeInteger(m["syncHighWaterMark"]), String(high) == c["syncHighWaterMark"],
              let goals = m["goalIds"] as? [String], !goals.isEmpty, Set(goals).count == goals.count,
              goals.allSatisfy({ $0.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$", options: .regularExpression) != nil }),
              let holds = m["sourceHolds"] as? [[String: Any]], let tables = m["tables"] as? [[String: Any]],
              !tables.isEmpty, Set(tables.compactMap { $0["name"] as? String }).count == tables.count,
              tables.allSatisfy({ row in Set(row.keys) == ["name", "rowCount", "sha256"] && isHash(row["sha256"] as? String) &&
                  (row["name"] as? String)?.range(of: "^[a-z_]+$", options: .regularExpression) != nil && safeInteger(row["rowCount"]) != nil }),
              holds.allSatisfy({ h in Set(h.keys) == ["provider", "goalId", "reason", "sourceEventId", "sourceGeneration", "sourceRevision"] &&
                  h["provider"] as? String == "okx" && h["reason"] as? String == "cloud_history_unsupported" &&
                  goals.contains(h["goalId"] as? String ?? "") && (h["sourceEventId"] as? String)?.isEmpty == false &&
                  (safeInteger(h["sourceGeneration"]) ?? 0) > 0 && (safeInteger(h["sourceRevision"]) ?? 0) > 0 &&
                  (safeInteger(h["sourceRevision"]) ?? UInt64.max) < 9_007_199_254_740_991 }) else { throw WorkspaceHandoffError.invalidProof }
        return m
    }
    private static func safeInteger(_ value: Any?) -> UInt64? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
              let v = UInt64(n.stringValue), v <= 9_007_199_254_740_991 else { return nil }
        return v
    }
    static func matchesStatus(_ status: [String: Any], claims c: [String: String], manifest m: [String: Any]) -> Bool {
        guard status["purpose"] as? String == purpose, let ready = status["handoffReady"] as? NSNumber,
              CFGetTypeID(ready) == CFBooleanGetTypeID(), ready.boolValue,
              safeInteger(status["eventProtocol"]) == 1,
              status["phase"] as? String == "target_active",
              status["hostCompanionSHA256"] as? String == m["hostCompanionSHA256"] as? String,
              let high = status["syncHighWaterMark"] as? NSNumber, CFGetTypeID(high) != CFBooleanGetTypeID(),
              high.stringValue == c["syncHighWaterMark"] else { return false }
        guard ["migrationId", "userId", "deviceId", "manifestSHA256", "importReceiptSHA256", "snapshotSHA256", "syncPrefixSHA256", "activationPermitSHA256"]
            .allSatisfy({ status[$0] as? String == c[$0] }),
              let raw = status["importReceiptUTF8"] as? String, raw.utf8.count <= 128 * 1024, hash(raw) == c["importReceiptSHA256"],
              let receipt = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
              Set(receipt.keys) == ["format", "manifestSHA256", "phase", "migrationId", "sourceUserId", "sourceDeviceId", "targetOrigin", "snapshotSHA256", "syncPrefixSHA256", "syncHighWaterMark", "activationPermitSHA256", "targetReceipt"],
              receipt["format"] as? String == "along-host-import-receipt/v1", receipt["manifestSHA256"] as? String == c["manifestSHA256"],
              receipt["phase"] as? String == "target_staged", receipt["migrationId"] as? String == c["migrationId"],
              receipt["sourceUserId"] as? String == c["userId"], receipt["sourceDeviceId"] as? String == c["deviceId"],
              receipt["targetOrigin"] as? String == c["targetOrigin"], receipt["snapshotSHA256"] as? String == c["snapshotSHA256"],
              receipt["syncPrefixSHA256"] as? String == c["syncPrefixSHA256"], safeInteger(receipt["syncHighWaterMark"]) == high.uint64Value,
              receipt["activationPermitSHA256"] as? String == c["activationPermitSHA256"],
              let target = receipt["targetReceipt"] as? [String: Any], Set(target.keys) == ["snapshotSHA256", "syncHighWaterMark", "sourceHolds"],
              isHash(target["snapshotSHA256"] as? String), let targetHigh = safeInteger(target["syncHighWaterMark"]), targetHigh >= high.uint64Value,
              let original = m["sourceHolds"] as? [[String: Any]], let applied = target["sourceHolds"] as? [[String: Any]], original.count == applied.count else { return false }
        if original.isEmpty && (target["snapshotSHA256"] as? String != c["snapshotSHA256"] || targetHigh != high.uint64Value) { return false }
        return zip(original, applied).allSatisfy { old, held in
            guard let revision = safeInteger(old["sourceRevision"]), revision < 9_007_199_254_740_991 else { return false }
            return Set(held.keys) == Set(old.keys).union(["eventId", "generation", "revision", "state"]) &&
                ["provider", "goalId", "reason", "sourceEventId"].allSatisfy { held[$0] as? String == old[$0] as? String } &&
                safeInteger(held["sourceGeneration"]) == safeInteger(old["sourceGeneration"]) &&
                safeInteger(held["sourceRevision"]) == safeInteger(old["sourceRevision"]) &&
                safeInteger(held["generation"]) == safeInteger(old["sourceGeneration"]) &&
                safeInteger(held["revision"]) == revision + 1 &&
                held["state"] as? String == "unavailable" && (held["eventId"] as? String)?.hasPrefix("handoff_hold_") == true
        }
    }
}

// Only Native reads this service. The source credential is retained for authenticating the
// recovery journal; it never authorizes restarting a retired source. Target secrets stay in Keychain.
@MainActor enum WorkspaceHandoffVault {
    private static let service = "com.artstur.AlongHealth.workspace-handoff"
    static func save(_ record: [String: Any], id: String) throws {
        let data = try JSONSerialization.data(withJSONObject: record)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id]
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let result = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if result == errSecItemNotFound {
            var add = query; add.merge(attrs) { _, new in new }
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw WorkspaceHandoffError.secretUnavailable }
        } else if result != errSecSuccess { throw WorkspaceHandoffError.secretUnavailable }
    }
    static func load(_ id: String) throws -> [String: Any] {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: id, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw WorkspaceHandoffError.secretUnavailable
        }
        return result
    }
}
