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
 static var posts=[String](), reads=[String](), fail=true, finished=false, immediate=false
 static var inputs=[String:[String:Any]](), blockedIDs=Set<String>()
 static func decision(id:String,ready:Bool)->[String:Any] {
  ["actual":true,"kind":"goal","runtime":"dsh-superagent","requestId":id,"status":blockedIDs.contains(id) ? "blocked" : (ready ? "done" : "working"),
   "input":inputs[id] ?? [:],"ticket":["id":"synthetic-ticket"],"result":["reassessment":["basedOnRevision":id,"nextReviewAt": NSNull()]]]
 }
 static func agentRequest(_ input:[String:Any],background:Bool) async throws->[String:Any] {
  precondition(background && input["token"] as? String == "synthetic")
  let body=input["body"] as! [String:Any], id=body["requestId"] as! String
  if input["path"] as? String == "/super-agent/goals/status" {
   reads.append(id)
   return decision(id:id,ready:finished)
  }
  posts.append(id);inputs[id]=body
  let file=URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("AlongBackgroundReviews/review.json")
  let state = try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]
  precondition((state["pending"] as? [String:Any])?["requestId"] as? String == id)
  if fail { throw AgentBridgeError.invalidConfiguration }
  return ["run":decision(id:id,ready:immediate)]
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
  // A calendar wake is able to run without a single new HealthKit observation.
  var dailyAllowed=false, registered=[Date?](), applied=[String](), notificationReady=false
  mgr.scheduleCalendarRefresh={ date in registered.append(date) }
  mgr.permitsDailyReview={ grant,key,types in dailyAllowed && grant["goalKey"] as? String==key && types==["workout"] }
  mgr.deliverDailyResult={ run,_,_ in
   if notificationReady { applied.append(run["requestId"] as! String) }
   return notificationReady
  }
  let formatter=DateFormatter();formatter.locale=Locale(identifier:"en_US_POSIX");formatter.timeZone = .current;formatter.dateFormat="yyyy-MM-dd"
  let yesterday=formatter.string(from:Calendar.current.date(byAdding:.day,value:-1,to:Date())!)
  let grant:[String:Any]=["id":"daily-grant-test-001","goalKey":"health","topics":["workout"],"weeklyWorkoutMinutes":120]
  var dt=t, dp=plan;dp["dailyDelegation"]=grant;dt["planning"]=dp;dt["version"]="calendar-v1";dt["evaluatedLocalDate"]=yesterday
  HealthKitReader.sample=10;AlongWebView.Coordinator.finished=false;AlongWebView.Coordinator.immediate=false
  _=try mgr.bridgeAction("replace",value:["goals":[dt]])
  precondition(registered.compactMap{$0}.isEmpty)
  dailyAllowed=true;mgr.dailyGrantChanged()
  precondition(registered.last! != nil)
  func wake() async -> Bool { await withCheckedContinuation { next in mgr.calendarRefresh { next.resume(returning:$0) } } }
  let previousPosts=AlongWebView.Coordinator.posts.count
  app.applicationState = .background;app.isProtectedDataAvailable=false
  let locked=await wake();precondition(!locked && AlongWebView.Coordinator.posts.count==previousPosts)
  app.isProtectedDataAvailable=true
  _=await wake()
  let dailyID=AlongWebView.Coordinator.posts.last!
  precondition(AlongWebView.Coordinator.posts.count==previousPosts+1 && applied.isEmpty)
  _=await wake()
  precondition(AlongWebView.Coordinator.posts.count==previousPosts+1 && applied.isEmpty)
  AlongWebView.Coordinator.finished=true
  _=await wake();precondition(applied.isEmpty)  // native queue declined; same ID must be retried
  notificationReady=true;_=await wake()
  precondition(applied==[dailyID] && AlongWebView.Coordinator.posts.count==previousPosts+1)
  _=await wake();precondition(applied==[dailyID])
  HealthKitReader.sample=21;AlongWebView.Coordinator.immediate=true
  await HealthKitReader.fire()
  let changedID=AlongWebView.Coordinator.posts.last!
  precondition(changedID != dailyID && applied==[dailyID,changedID])
  _=await wake();precondition(applied==[dailyID,changedID])
  // Simulate last night's persisted accepted request and the same paired Host's matching blocked ticket.
  let url=URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("AlongBackgroundReviews/review.json")
  var disk=try JSONSerialization.jsonObject(with:Data(contentsOf:url)) as! [String:Any]
  var waiting=disk["pending"] as! [String:Any], oldRequest=waiting["request"] as! [String:Any]
  var oldFacts=oldRequest["snapshot"] as! [String:Any], oldPlanning=oldFacts["planning"] as! [String:Any]
  AlongWebView.Coordinator.blockedIDs.insert(changedID)
  disk.removeValue(forKey:"completed")
  try JSONSerialization.data(withJSONObject:disk).write(to:url)
  _=await wake();precondition(AlongWebView.Coordinator.posts.count==previousPosts+2)  // same-day blocked
  oldPlanning["localDate"]=yesterday;oldFacts["planning"]=oldPlanning;oldRequest["snapshot"]=oldFacts
  waiting["request"]=oldRequest;disk["pending"]=waiting
  try JSONSerialization.data(withJSONObject:disk).write(to:url)
  _=await wake();precondition(AlongWebView.Coordinator.posts.count==previousPosts+2)  // Host still shows a different date
  AlongWebView.Coordinator.inputs[changedID]=oldRequest
  _=await wake()
  let afterBlocked=try JSONSerialization.jsonObject(with:Data(contentsOf:url)) as! [String:Any]
  precondition(AlongWebView.Coordinator.posts.count==previousPosts+3 && (afterBlocked["lastBlocked"] as? [String:Any])?["requestId"] as? String==changedID)
  precondition((afterBlocked["pending"] as? [String:Any])?["previousRequestId"]==nil)
  dailyAllowed=false;mgr.dailyGrantChanged();HealthKitReader.sample=22
  let revokedWake=await wake();precondition(!revokedWake && AlongWebView.Coordinator.posts.count==previousPosts+3)
  print("verified")
 }
}`;
   writeFileSync(file,prelude+'\n'+core+'\n'+scenario);
   execFileSync('xcrun',['swiftc','-parse-as-library',file,'-o',bin],{stdio:'pipe',timeout:90000});
   assert.match(execFileSync(bin,[dir,module,'along.background.fixture.'+randomUUID()],{encoding:'utf8',timeout:10000}),/verified/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
