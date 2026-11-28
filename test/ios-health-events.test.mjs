import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const hasSwift=spawnSync('swiftc',['--version']).status===0;
test('native event summaries preserve windows, latest-reading dates, unknowns, scalar-only data and matching receipts',{skip:!hasSwift},()=>{
 const source=readFileSync(new URL('../ios/AlongHealth/Sources/HealthKitReader.swift',import.meta.url),'utf8');
 const pure=source.slice(source.indexOf('enum HealthEventOutbox {'));
 const dir=mkdtempSync(join(tmpdir(),'along-health-events-'));
 try {
  writeFileSync(join(dir,'Check.swift'),`import Foundation
${pure}
@main struct Check {
 static func main() throws {
  let now=ISO8601DateFormatter().date(from:"2026-11-16T04:00:00Z")!
  var calendar=Calendar(identifier:.gregorian);calendar.timeZone=TimeZone(identifier:"Asia/Shanghai")!
  let observed=now.addingTimeInterval(-3600)
  var summary=HealthSummary(selected:HealthMetric.allCases,capturedAt:now,steps:0,workoutMinutes:40,weightKg:70,sleepMinutes:420)
  summary.readingDates=[.weight:observed]
  let rows=summary.eventSummaries(calendar:calendar)
  precondition(rows.count==7)
  let step=rows.first{$0["type"] as? String=="steps"}!
  precondition(step["availability"] as? String=="ok" && step["value"] as? Double==0)
  let missing=rows.first{$0["type"] as? String=="resting_heart_rate"}!
  precondition(missing["availability"] as? String=="unavailable" && missing["value"] is NSNull)
  let weight=rows.first{$0["type"] as? String=="weight"}!, window=weight["window"] as! [String:String]
  precondition(window["start"]=="2026-11-16T03:00:00.000Z" && window["end"]==window["start"])
  precondition(rows.allSatisfy{($0["value"] is Double || $0["value"] is NSNull) && $0["samples"]==nil})
  var repeated=rows;for i in repeated.indices {repeated[i]["metric_version"]="2026-11-16T05:00:00.000Z"}
  precondition(try HealthEventOutbox.content(rows)==HealthEventOutbox.content(repeated))
  let event:[String:Any]=["event_id":"stable-event","payload":["summaries":rows]]
  precondition(HealthEventOutbox.acknowledged(event,by:["event_id":"stable-event","status":"accepted"]))
  precondition(HealthEventOutbox.acknowledged(event,by:["event_id":"stable-event","status":"duplicate"]))
  precondition(!HealthEventOutbox.acknowledged(event,by:["event_id":"wrong","status":"accepted"]))
  precondition(!HealthEventOutbox.acknowledged(event,by:["event_id":"stable-event","status":"rejected"]))
  precondition(HealthEventOutbox.permitted(event,types:Set(HealthMetric.allCases)))
  precondition(!HealthEventOutbox.permitted(event,types:[.steps]))
  print("native aggregate and receipt invariants passed")
 }
}`.replace('precondition(try HealthEventOutbox.content(rows)==HealthEventOutbox.content(repeated))','let a=try HealthEventOutbox.content(rows), b=try HealthEventOutbox.content(repeated);precondition(a==b)'));
  execFileSync('swiftc',['-parse-as-library',fileURLToPath(new URL('../ios/AlongHealth/Sources/DeviceEventQueue.swift',import.meta.url)),fileURLToPath(new URL('../ios/AlongHealth/Sources/HealthModels.swift',import.meta.url)),join(dir,'Check.swift'),'-o',join(dir,'check')],{timeout:30000});
  assert.match(execFileSync(join(dir,'check'),{encoding:'utf8',timeout:10000}),/invariants passed/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('the real native outbox persists before sending, retries the same id after restart, isolates pairing and defers locked reads',{skip:!hasSwift},()=>{
 const shell=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
 const bindingScope=shell.match(/    static func bindingScopeId\([\s\S]*?\n    }/)[0];
 const source=readFileSync(new URL('../ios/AlongHealth/Sources/HealthKitReader.swift',import.meta.url),'utf8');
 const collectors=readFileSync(new URL('../ios/AlongHealth/Sources/DeviceDataCollectors.swift',import.meta.url),'utf8').split('@MainActor struct OKXDeviceDataCollector')[0];
 const core=source.slice(source.indexOf('@MainActor final class HealthEventDelivery {'))
  .replaceAll('UserDefaults.standard','TestEnvironment.settings')
  .replace(/let dir = try FileManager.default.url\(for:[^\n]+/,'let dir = URL(fileURLWithPath: CommandLine.arguments[1])')
  .replaceAll('attributes: [.protectionKey: FileProtectionType.complete]','attributes: nil')
  .replaceAll('options: [.atomic, .completeFileProtection]','options: [.atomic]');
 const dir=mkdtempSync(join(tmpdir(),'along-health-outbox-'));
 try {
  writeFileSync(join(dir,'Check.swift'),`import Foundation
import CryptoKit
@MainActor enum TestEnvironment {static let settings=UserDefaults(suiteName:CommandLine.arguments[2])!}
@MainActor final class UIApplication {
 enum State {case active,background};static let shared=UIApplication();var applicationState=State.background;var isProtectedDataAvailable=true
}
enum AgentBridgeError:Error {case invalidConfiguration; case receipt([String:Any])}
@MainActor enum AlongConnectionStore {
 static var pair=["baseURL":"https://192.0.2.1:4176","token":String(repeating:"b",count:64)]
 static let systemTrustPolicy="system-pki-v1"
 static func load()->[String:String]? {pair}
 ${bindingScope}
 static func scopeSeed(_ connection:[String:String])->String? {
  guard let base=connection["baseURL"],let token=connection["token"] else {return nil}
  return connection["bindingScopeId"] ?? bindingScopeId(baseURL:base,token:token)
 }

}
@MainActor final class BackgroundHealthReviews {
 static let shared=BackgroundHealthReviews();var usesEventProtocol:()->Bool={false}
 func disarm(){};func configureObservers(){}
}
@MainActor final class HealthKitReader {
 static var reads=0;static var steps=1000
 func observeChanges(_ s:Set<HealthMetric>,onChange:@escaping(@escaping()->Void)->Void){}
 func updateBackgroundDelivery(_ s:Set<HealthMetric>){}
 func read(_ s:Set<HealthMetric>,requestPermission:Bool,includeContext:Bool)async throws->HealthSummary {
  precondition(!requestPermission&&includeContext);Self.reads+=1
  return HealthSummary(selected:Array(s),capturedAt:Date(),steps:Self.steps)
 }
}
@MainActor enum AlongWebView {enum Coordinator {
 static var fail=true, wrong=false, reject=false;static var ids=[String]()
 static func agentRequest(_ input:[String:Any],background:Bool)async throws->[String:Any] {
  if input["path"] as? String=="/connection/status" {return ["eventProtocol":1,"ready":true,"userId":"synthetic-user"]}
  let event=input["body"] as! [String:Any], id=event["event_id"] as! String
  let file=URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("AlongHealthEvents/outbox.json")
  let saved=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]
  precondition((saved["pending"] as! [[String:Any]]).contains{$0["event_id"] as? String==id},"must persist before send")
  ids.append(id)
  if fail {throw AgentBridgeError.invalidConfiguration}
  if reject {throw AgentBridgeError.receipt(["status":"rejected","event_id":id])}
  return ["status":"accepted","event_id":wrong ? "wrong" : id]
 }
}}
${collectors}
${core}
@main struct Fixture {
 @MainActor static func settle()async {for _ in 0..<40 {try? await Task.sleep(for:.milliseconds(5))}}
 @MainActor static func main()async throws {
  let settings=TestEnvironment.settings;defer {settings.removePersistentDomain(forName:CommandLine.arguments[2])}
  settings.set(true,forKey:"along.health.contextReview.v1");settings.set(["steps"],forKey:"along.health.selectedTypes")
  let mgr=HealthEventDelivery.shared
  _=try await mgr.configure();await settle()
  precondition(AlongWebView.Coordinator.ids.count==1)
  let first=AlongWebView.Coordinator.ids[0]
  // A second manager loads exactly the same protected file, as a relaunched process would.
  let restarted=HealthEventDelivery();AlongWebView.Coordinator.fail=false;AlongWebView.Coordinator.wrong=true
  restarted.request();await settle();precondition(AlongWebView.Coordinator.ids.last==first)
  AlongWebView.Coordinator.wrong=false;restarted.request();await settle()
  precondition(AlongWebView.Coordinator.ids.count==3 && Set(AlongWebView.Coordinator.ids).count==1)
  let file=URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("AlongHealthEvents/outbox.json")
  let saved=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]
  precondition((saved["pending"] as! [[String:Any]]).isEmpty)
  restarted.request();await settle();precondition(AlongWebView.Coordinator.ids.count==3,"same facts stay quiet")
  HealthKitReader.steps=2000;AlongWebView.Coordinator.reject=true
  restarted.request();await settle()
  AlongWebView.Coordinator.reject=false;HealthKitReader.steps=3000
  restarted.request();await settle()
  precondition(AlongWebView.Coordinator.ids.count==5,"a rejected snapshot must not block a later valid update")
  let current=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]
  precondition((current["held"] as! [[String:Any]]).count==1 && (current["pending"] as! [[String:Any]]).isEmpty)
  UIApplication.shared.isProtectedDataAvailable=false;let reads=HealthKitReader.reads
  restarted.request();await settle();precondition(reads==HealthKitReader.reads)
  UIApplication.shared.isProtectedDataAvailable=true;AlongConnectionStore.pair["token"]=String(repeating:"c",count:64)
  restarted.request();await settle();precondition(AlongWebView.Coordinator.ids.count==5,"must not send to a changed pairing")
  print("durable outbox invariants passed")
 }
}`);
  const bin=join(dir,'check');
  execFileSync('swiftc',['-parse-as-library',fileURLToPath(new URL('../ios/AlongHealth/Sources/DeviceEventQueue.swift',import.meta.url)),fileURLToPath(new URL('../ios/AlongHealth/Sources/HealthModels.swift',import.meta.url)),join(dir,'Check.swift'),'-o',bin],{timeout:120000});
  assert.match(execFileSync(bin,[dir,`along-health-event-${Date.now()}`],{encoding:'utf8',timeout:10000}),/durable outbox invariants passed/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
