import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

test('native background submissions preserve scope, recover with the original ID, and advance after a confirmed DSH result',()=>{
 const source=readFileSync(new URL('../ios/AlongHealth/Sources/HealthKitReader.swift',import.meta.url),'utf8');
 const core=source.slice(source.indexOf('enum BackgroundReviewAdmission'),source.indexOf('@MainActor final class HealthDeliveryAppDelegate'))
   .replace('UserDefaults.standard','TestEnvironment.settings')
   .replace('Bundle.main.url(forResource: "contextual-planning", withExtension: "mjs", subdirectory: "Web")','Optional(URL(fileURLWithPath: CommandLine.arguments[2]))')
   .replace(/let dir = try FileManager.default.url\(for:[^\n]+/,'let dir = URL(fileURLWithPath: CommandLine.arguments[1])')
   .replace('attributes: [.protectionKey: FileProtectionType.complete]','attributes: nil')
   .replace('options: [.atomic, .completeFileProtection]','options: [.atomic]');
 const dir=mkdtempSync(join(tmpdir(),'along-bg-runtime-'));
 try {
   const file=join(dir,'test.swift'),bin=join(dir,'fixture'),module=fileURLToPath(new URL('../web/contextual-planning.mjs',import.meta.url));
   const prelude=`import Foundation
import JavaScriptCore
import CryptoKit
@MainActor enum TestEnvironment {
 static let settings = UserDefaults(suiteName: CommandLine.arguments[3])!
}
enum HealthMetric: String { case workout, sleep }
@MainActor final class UIApplication {
 enum State { case active, background }
 static let shared = UIApplication()
 var applicationState = State.active
 var isProtectedDataAvailable = true
}
enum AgentBridgeError: Error { case invalidConfiguration }
@MainActor enum AlongConnectionStore {
 static var pair = ["baseURL":"https://192.0.2.1:4176","token":"synthetic","fingerprint":"expected"]
 static func load() -> [String:String]? { pair }
}
@MainActor final class HealthKitReader {
 static var update: ((@escaping () -> Void) -> Void)?
 static var sample = 20
 static var reads = 0
 static var lastSelection = Set<HealthMetric>()
 func updateBackgroundDelivery(_ selected: Set<HealthMetric>) { Self.lastSelection=selected }
 func observeChanges(_ selected: Set<HealthMetric>, onChange: @escaping (@escaping ()->Void)->Void) { Self.update=onChange }
 func read(_ selected: Set<HealthMetric>,requestPermission:Bool,includeContext:Bool,includeComparisonHistory:Bool) async throws -> Snapshot {
  precondition(!requestPermission && includeContext && !includeComparisonHistory && selected == [.workout])
  Self.reads+=1; return Snapshot(value:Self.sample)
 }
 static func fire() async {
  guard let update else { fatalError("missing observer") }
  await withCheckedContinuation { next in update { next.resume() } }
 }
}
struct Snapshot {
 var value:Int
 var hasReadableValue:Bool { value >= 0 }
 func browserSnapshot(contextReviewAllowed:Bool,comparisonHistoryAllowed:Bool)->[String:Any] {
  ["selectedTypes":["workout"],"contextReviewAllowed":true,"comparisonHistoryAllowed":false,"capturedAt":ISO8601DateFormatter().string(from:Date()),"workoutMinutes":value]
 }
}
@MainActor enum AlongWebView { enum Coordinator {
 static var posts=[String](), reads=[String](), fail=true, finished=false
 static func agentRequest(_ input:[String:Any],background:Bool) async throws->[String:Any] {
  precondition(background && input["token"] as? String == "synthetic")
  let body=input["body"] as! [String:Any], id=body["requestId"] as! String
  if input["path"] as? String == "/super-agent/goals/status" {
   reads.append(id)
   return ["actual":true,"runtime":"dsh-superagent","requestId":id,"status":finished ? "done" : "working","ticket":["id":"synthetic-ticket"],"result":["reassessment":["basedOnRevision":id,"nextReviewAt": NSNull()]]]
  }
  posts.append(id)
  let file=URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("AlongBackgroundReviews/review.json")
  let state = try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]
  precondition((state["pending"] as? [String:Any])?["requestId"] as? String == id)
  if fail { throw AgentBridgeError.invalidConfiguration }
  return ["run":["actual":true,"runtime":"dsh-superagent","requestId":id]]
 }
}}
`;
   const scenario=`@main struct Fixture {
 @MainActor static func main() async throws {
  let prefs=TestEnvironment.settings
  defer { prefs.removePersistentDomain(forName: CommandLine.arguments[3]) }
  prefs.set(true,forKey:"along.health.contextReview.v1");prefs.set("health",forKey:"along.health.backgroundReviewGoal.v1")
  prefs.set(["sleep","workout"],forKey:"along.health.selectedTypes")
  let mgr=BackgroundHealthReviews(), app=UIApplication.shared
  let baseline:[String:Any]=["selectedTypes":["workout"],"workoutMinutes":10,"contextReviewAllowed":true]
  let plan:[String:Any]=["version":1,"kind":"context-review","previous":baseline,"goalIntent":"合成任务","currentPlan":["tasks":[]]]
  let t:[String:Any]=["goalKey":"health","version":"v1","goal":["domain":"health","title":"示例"],"planning":plan,"selectedTypes":["workout"],"runtime":"dsh-superagent","paused":false,"comparisonHistoryAllowed":false]
  _=try mgr.bridgeAction("replace",value:["goals":[t]])
  precondition(HealthKitReader.lastSelection == [.workout])
  app.applicationState = .background;app.isProtectedDataAvailable=false
  await HealthKitReader.fire()
  precondition(HealthKitReader.reads==0 && AlongWebView.Coordinator.posts.isEmpty)
  app.isProtectedDataAvailable=true;HealthKitReader.sample = -1
  await HealthKitReader.fire()
  precondition(AlongWebView.Coordinator.posts.isEmpty)
  HealthKitReader.sample=20
  await HealthKitReader.fire()
  let first=AlongWebView.Coordinator.posts[0]
  AlongWebView.Coordinator.fail=false
  await HealthKitReader.fire()
  precondition(AlongWebView.Coordinator.posts == [first,first])
  _ = try mgr.bridgeAction("replace",value:["goals":[t]])
  HealthKitReader.sample=32
  await HealthKitReader.fire()
  precondition(AlongWebView.Coordinator.reads.contains(first) && AlongWebView.Coordinator.posts.count == 2)
  AlongWebView.Coordinator.finished=true
  await HealthKitReader.fire()
  let latest=AlongWebView.Coordinator.posts.last!
  precondition(latest != first && AlongWebView.Coordinator.posts.count==3)
  await HealthKitReader.fire()
  precondition(AlongWebView.Coordinator.posts.count==3)
  app.applicationState = .active;mgr.foregroundStarted()
  let payload=["goalKey":"health","version":"v1"]
  let receipts = try mgr.bridgeAction("pending",value:payload)["runs"] as! [[String:Any]]
  _ = try mgr.bridgeAction("disarm",value:[:])
  let held = try mgr.bridgeAction("pending",value:payload)["runs"] as! [[String:Any]]
  precondition(held.count==1 && held[0]["requestId"] as? String == latest)
  precondition(receipts.count==1 && receipts[0]["requestId"] as? String == latest && receipts[0]["previousRequestId"] as? String == first)
  precondition((receipts[0]["baseline"] as? [String:Any])?["workoutMinutes"] as? Int == 20)
  let foreign=try mgr.bridgeAction("pending",value:["goalKey":"custom:other","version":"v1"])["runs"] as! [[String:Any]]
  precondition(foreign.isEmpty)
  AlongConnectionStore.pair["token"]="new-pair"
  let other=try mgr.bridgeAction("pending",value:payload)["runs"] as! [[String:Any]]
  precondition(other.isEmpty)
  AlongConnectionStore.pair["token"]="synthetic"
  _=try mgr.bridgeAction("replace",value:["goals":[]])
  let revoked=try mgr.bridgeAction("pending",value:payload)["runs"] as! [[String:Any]]
  precondition(revoked.isEmpty && HealthKitReader.lastSelection.isEmpty)
  print("verified")
 }
}`;
   writeFileSync(file,prelude+'\n'+core+'\n'+scenario);
   execFileSync('xcrun',['swiftc','-parse-as-library',file,'-o',bin],{stdio:'pipe',timeout:90000});
   assert.match(execFileSync(bin,[dir,module,'along.background.fixture.'+randomUUID()],{encoding:'utf8',timeout:10000}),/verified/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
