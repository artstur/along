import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const source=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
const models=new URL('../ios/AlongHealth/Sources/HealthModels.swift',import.meta.url);
const bridge=source.slice(source.indexOf('enum HealthImportAdmission'),source.indexOf('enum AlongConnectionStore'));
const hasSwift=spawnSync('swiftc',['--version']).status===0;

test('iOS serializes foreground reads and rechecks changes that arrive during a read',{skip:!hasSwift},()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-refresh-'));
  try {
    const file=join(dir,'Check.swift');
    writeFileSync(file,`import Foundation
@propertyWrapper struct Published<T> { var wrappedValue: T }
protocol ObservableObject {}
final class WKWebView {
    var messages = [String]()
    func evaluateJavaScript(_ script: String) { messages.append(script) }
}
@MainActor final class TestDefaults {
    static let standard = TestDefaults()
    var values: [String: Any] = [:]
    func set(_ value: Any, forKey key: String) { values[key] = value }
    func bool(forKey key: String) -> Bool { values[key] as? Bool ?? false }
    func stringArray(forKey key: String) -> [String]? { values[key] as? [String] }
    func removeObject(forKey key: String) { values.removeValue(forKey: key) }
}
@MainActor final class HealthKitReader {
    static var pending: [CheckedContinuation<HealthSummary, Never>] = []
    static var reads = 0
    static var peak = 0
    static var historyReads: [Bool] = []
    func observe(_ selected: Set<HealthMetric>, onChange: @escaping () -> Void) {}
    func stopObserving() {}
    func read(_ selected: Set<HealthMetric>, requestPermission: Bool = true, includeContext: Bool = true, includeComparisonHistory: Bool = false) async throws -> HealthSummary {
        Self.reads += 1
        Self.historyReads.append(includeComparisonHistory)
        return await withCheckedContinuation {
            Self.pending.append($0)
            Self.peak = max(Self.peak, Self.pending.count)
        }
    }
    static func finish(_ steps: Int) {
        guard !pending.isEmpty else { return }
        pending.removeFirst().resume(returning: HealthSummary(selected: [.steps], capturedAt: Date(), steps: steps))
    }
}
${bridge.replaceAll('UserDefaults.standard','TestDefaults.standard')}
@main struct Check {
    @MainActor static func settle() async {
        for _ in 0..<12 { await Task.yield() }
    }
    @MainActor static func main() async {
        let model = AlongBridgeModel()
        let view = WKWebView()
        TestDefaults.standard.set(["steps"], forKey: "along.health.selectedTypes")
        TestDefaults.standard.set(true, forKey: "along.health.contextReview.v1")
        model.attach(view)
        await settle()
        model.refreshHealth()
        model.refreshHealth()
        HealthKitReader.finish(1)
        await settle()
        print("reads after observer burst", HealthKitReader.reads)
        print("legacy has history permission", HealthKitReader.historyReads.contains(true))
        TestDefaults.standard.set(true, forKey: "along.health.comparisonHistory.v1")
        model.refreshSnapshot(id: "web-poll", webView: view)
        model.refreshSnapshot(id: "second-poll", webView: view)
        await settle()
        print("overlapping reads", HealthKitReader.peak)
        HealthKitReader.finish(2)
        await settle()
        HealthKitReader.finish(3)
        await settle()
        print("answered poll", view.messages.contains { $0.contains("web-poll") })
        print("new history permission honored", HealthKitReader.historyReads.last == true)
        print("answered second poll", view.messages.contains { $0.contains("second-poll") })
        model.refreshHealth()
        await settle()
        print("read in flight when cleared", !HealthKitReader.pending.isEmpty)
        model.clearHealth(id: "clear", webView: view)
        HealthKitReader.finish(999)
        await settle()
        print("cleared history permission", !TestDefaults.standard.bool(forKey: "along.health.comparisonHistory.v1"))
        print("revoked sample published", view.messages.contains { $0.contains(#""steps":999"#) })
        model.refreshSnapshot(id: "missing", webView: view)
        print("missing selection code", view.messages.last?.contains("health_not_connected") ?? false)
    }
}`);
    const exe=join(dir,'check');
    execFileSync('swiftc',['-parse-as-library','-module-cache-path',join(dir,'cache'),fileURLToPath(models),file,'-o',exe],{stdio:'pipe'});
    const output=execFileSync(exe,{encoding:'utf8'});
    assert.match(output,/reads after observer burst 2/);
    assert.match(output,/legacy has history permission false/);
    assert.match(output,/new history permission honored true/);
    assert.match(output,/cleared history permission true/);
    assert.match(output,/overlapping reads 1/);
    assert.match(output,/answered poll true/);
    assert.match(output,/answered second poll true/);
    assert.match(output,/read in flight when cleared true/);
    assert.match(output,/revoked sample published false/);
    assert.match(output,/missing selection code true/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
