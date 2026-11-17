import Foundation

enum DeviceDataProvider: String { case appleHealth = "apple-health", okx }

// Provider implementations own permissions and validation. The shared delivery
// layer never receives a URL, signing key or model-selected request parameters.
@MainActor protocol DeviceDataCollector {
    associatedtype Observation
    var provider: DeviceDataProvider { get }
    func collect() async throws -> Observation
}

@MainActor struct HealthDeviceDataCollector: DeviceDataCollector {
    let reader: HealthKitReader
    let types: Set<HealthMetric>
    let provider = DeviceDataProvider.appleHealth
    func collect() async throws -> HealthSummary {
        try await reader.read(types, requestPermission: false, includeContext: true)
    }
}

@MainActor struct OKXDeviceDataCollector: DeviceDataCollector {
    let client: OKXDeviceClient
    let site: OKXDeviceSite
    let credentials: OKXDeviceCredentials
    let provider = DeviceDataProvider.okx
    func collect() async throws -> OKXDeviceObservation {
        try await client.collect(site: site, credentials: credentials)
    }
}
