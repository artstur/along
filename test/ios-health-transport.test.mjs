import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const hasSwift=process.platform==='darwin'&&spawnSync('swiftc',['--version']).status===0;
const shell=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
const handoff=readFileSync(new URL('../ios/AlongHealth/Sources/WorkspaceHandoff.swift',import.meta.url),'utf8');
function method(source,marker) {
 const start=source.indexOf(marker);assert.ok(start>=0,marker);
 const brace=source.indexOf('{',start);let depth=1,end=brace+1;
 for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;if(source[end]==='}')depth--;}
 return source.slice(start,end);
}

test('verified same-Mac address updates retain the original active health event and isolate unverified identities',{skip:!hasSwift},()=>{
 const source=readFileSync(new URL('../ios/AlongHealth/Sources/HealthKitReader.swift',import.meta.url),'utf8');
 const core=source.slice(source.indexOf('@MainActor final class HealthEventDelivery {'))
  .replaceAll('UserDefaults.standard','TestEnvironment.settings')
  .replace(/let dir = try FileManager.default.url\(for:[^\n]+/,'let dir = URL(fileURLWithPath: CommandLine.arguments[1])')
  .replaceAll('attributes: [.protectionKey: FileProtectionType.complete]','attributes: nil')
  .replaceAll('options: [.atomic, .completeFileProtection]','options: [.atomic]');
 const collectors=readFileSync(new URL('../ios/AlongHealth/Sources/DeviceDataCollectors.swift',import.meta.url),'utf8').split('@MainActor struct OKXDeviceDataCollector')[0];
 const methods=['bindingScopeId','trustPolicy','isPrivateIPv4','scopeSeed','hostAccepted','clean','permitsPairedTransport'].map(name=>method(shell,`    static func ${name}(`)).join('\n');
 const notifications=readFileSync(new URL('../ios/AlongHealth/Sources/EventTaskNotifications.swift',import.meta.url),'utf8');
 const dir=mkdtempSync(join(tmpdir(),'along-health-transport-'));
 try {
  writeFileSync(join(dir,'Check.swift'),`import Foundation
import CryptoKit
${handoff}
@MainActor enum TestEnvironment {static let settings=UserDefaults(suiteName:CommandLine.arguments[2])!}
@MainActor final class UIApplication {
 enum State {case active,background};static let shared=UIApplication();var applicationState=State.background;var isProtectedDataAvailable=true
}
enum AgentBridgeError:Error {case invalidConfiguration;case receipt([String:Any])}
@MainActor enum AlongConnectionStore {
 static let legacyPinPolicy="legacy-local-pin-v1",systemTrustPolicy="system-pki-v1"
 static var pair=[String:String](),failSave=false,saveRevision:UInt64=0
 ${methods}
 ${method(shell,'    static func bootstrapFromEnvironment(')}
 static func checkLocalRoute(_ url:URL)async {}
 static func load()->[String:String]? {pair}
 static func save(_ value:[String:Any])->[String:String]? {guard !failSave,let c=clean(value) else{return nil};pair=c;saveRevision &+= 1;return c}
}
@MainActor final class BackgroundHealthReviews {
 static let shared=BackgroundHealthReviews();var usesEventProtocol:()->Bool={false}
 func disarm(){};func configureObservers(){}
}
@MainActor final class HealthKitReader {
 static var reads=0
 static var snapshot:HealthSummary {HealthSummary(selected:[.steps],capturedAt:ISO8601DateFormatter().date(from:"2026-11-24T04:00:00Z")!,steps:1000)}
 func observeChanges(_ s:Set<HealthMetric>,onChange:@escaping(@escaping()->Void)->Void){}
 func updateBackgroundDelivery(_ s:Set<HealthMetric>){}
 func read(_ s:Set<HealthMetric>,requestPermission:Bool,includeContext:Bool)async throws->HealthSummary {Self.reads+=1;return Self.snapshot}
}
@MainActor enum AlongWebView {@MainActor enum Coordinator {
 static var user="synthetic-user",failStatus=false,failEvent=true,wrong=false,reject=false,statusReady=true
 static var statusProtocol=1
 static var events=[[String:Any]](),statusCalls=0
 static var onStatus:(()async throws->Void)?,onEvent:(()async throws->Void)?
 static func notificationOperation(_ input:[String:Any])async throws->[String:Any] {["status":"authorized"]}
 static func agentRequest(_ input:[String:Any],background:Bool=false,privateWorkspaceHandoffRequest:Bool=false)async throws->[String:Any] {
  if input["path"] as? String=="/connection/verify" {return ["paired":true]}
  if input["path"] as? String=="/connection/status" {
   statusCalls+=1
   try await onStatus?()
   if failStatus {throw AgentBridgeError.invalidConfiguration}
   return ["eventProtocol":statusProtocol,"ready":statusReady,"userId":user]
  }
  let event=input["body"] as! [String:Any],id=event["event_id"] as! String
  let saved=try Fixture.read()
  precondition((saved["pending"] as! [[String:Any]]).contains{$0["event_id"] as? String==id},"persist before sending")
  events.append(event)
  try await onEvent?()
  if failEvent {throw AgentBridgeError.invalidConfiguration}
  if reject {throw AgentBridgeError.receipt(["status":"rejected","event_id":id])}
  return ["status":"accepted","event_id":wrong ? "wrong" : id]
 }
}}
${collectors}
${core}
enum DailyReminderScope {
 static func hash(_ text:String)->String {SHA256.hash(data:Data(text.utf8)).map{String(format:"%02x",$0)}.joined()}
}
@MainActor final class NotificationProbe {
 let defaults=TestEnvironment.settings,scopeKey="along.event.notification.scope",sinceKey="along.event.notification.since",receiptsKey="along.event.notification.results",routeKey="along.event.notification.route"
 var checkedScope:String?,cursor = -1,sentPlan:Data?,planExpires=Date.distantPast
 var pendingRoute:[String:Any]? {defaults.dictionary(forKey:routeKey)}
 ${method(notifications,'    private func verified(').replace('private func','func')}
}
@main struct Fixture {
 @MainActor static let settings=TestEnvironment.settings
 @MainActor static var file:URL {URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("AlongHealthEvents/outbox.json")}
 @MainActor static func bytes(_ value:[String:Any])throws->Data {try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])}
 @MainActor static func read()throws->[String:Any] {try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]}
 @MainActor static func write(_ value:[String:Any])throws {try bytes(value).write(to:file,options:.atomic)}
 @MainActor static func hash(_ c:[String:String])->String {SHA256.hash(data:Data(AlongConnectionStore.scopeSeed(c)!.utf8)).map{String(format:"%02x",$0)}.joined()}
 @MainActor static var old:[String:String] {AlongConnectionStore.clean(["baseURL":"https://192.168.10.2:4176","token":String(repeating:"b",count:64),"fingerprint":String(repeating:"A",count:64)])!}
 @MainActor static var next:[String:String] {var c=old;c["baseURL"]="https://192.168.10.9:4176";return AlongConnectionStore.clean(c)!}
 @MainActor static func settle()async {for _ in 0..<30 {try? await Task.sleep(for:.milliseconds(3))}}
 @MainActor static func seed(_ c:[String:String]?=nil)throws->[String:Any] {
  let c=c ?? old
  AlongConnectionStore.pair=c;AlongConnectionStore.failSave=false
  AlongWebView.Coordinator.user="synthetic-user";AlongWebView.Coordinator.failStatus=false;AlongWebView.Coordinator.failEvent=true
  AlongWebView.Coordinator.wrong=false;AlongWebView.Coordinator.reject=false;AlongWebView.Coordinator.statusReady=true;AlongWebView.Coordinator.statusProtocol=1;AlongWebView.Coordinator.onEvent=nil;AlongWebView.Coordinator.onStatus=nil;AlongWebView.Coordinator.events=[]
  settings.set(hash(c),forKey:"along.health.events.binding.v1")
  settings.set(true,forKey:"along.health.contextReview.v1");settings.set(["steps"],forKey:"along.health.selectedTypes")
  let rows=HealthKitReader.snapshot.eventSummaries()
  let event:[String:Any]=["event_id":"original-event","event_type":"along.health_summary_updated","payload":["summaries":rows]]
  let state:[String:Any]=["binding":hash(c),"user":"synthetic-user","pending":[event],"held":[["retained":"held-event","receipt":["status":"rejected"]]],"lastContent":try HealthEventOutbox.content(rows),"extra":"must-survive"]
  try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
  try write(state);return state
 }
 @MainActor static func expectFailure(_ operation:()async throws->Void)async throws {
  var failed=false;do{try await operation()}catch{failed=true};precondition(failed,"must reject")
 }
 @MainActor static func main()async throws {
  defer {settings.removePersistentDomain(forName:CommandLine.arguments[2])}
  let mgr=HealthEventDelivery()
  let original=try seed()
  await AlongConnectionStore.bootstrapFromEnvironment()
  precondition(AlongConnectionStore.pair==next && (try read()["pending"] as! [[String:Any]]).count==1)
  precondition(try read()["verifiedLocalTransports"] != nil)
  _=try seed()
  _=try await mgr.saveConnection(next)
  let migrated=try read()
  for key in ["binding","user","pending","held","lastContent","extra"] {
   precondition(try bytes([key:migrated[key]!])==bytes([key:original[key]!]),"migration must preserve \\(key)")
  }
  precondition(settings.string(forKey:"along.health.events.binding.v1")==hash(old))
  let nativeProof=mgr.connectionForWeb(AlongConnectionStore.pair)["transportMigration"] as! [String:String]
  precondition(nativeProof["fromBaseURL"]==old["baseURL"] && nativeProof["toBaseURL"]==next["baseURL"] && nativeProof["userId"]=="synthetic-user")
  let originalScope=DailyReminderScope.hash([AlongConnectionStore.scopeSeed(old)!,"synthetic-user"].joined(separator:"\\n"))
  settings.set(originalScope,forKey:"along.event.notification.scope");settings.set(123,forKey:"along.event.notification.since");settings.set(["original-receipt"],forKey:"along.event.notification.results")
  let np=NotificationProbe(),verifiedScope=try await np.verified(AlongConnectionStore.pair,user:"synthetic-user")
  precondition(verifiedScope==originalScope && settings.integer(forKey:"along.event.notification.since")==123 && settings.stringArray(forKey:"along.event.notification.results")==["original-receipt"])
  let offlineOwner=mgr.cachedWorkspaceBinding(AlongConnectionStore.pair)
  precondition(offlineOwner["userId"]=="synthetic-user" && offlineOwner["bindingScopeId"]==next["bindingScopeId"])
  print("PASS: native proof maps exact old/new Web bindings and preserves actual notification scope/receipts plus offline owner")
  _=try await mgr.configure();await settle()
  precondition(AlongWebView.Coordinator.events.count==1,"same content must not create a second event")
  precondition(try bytes(AlongWebView.Coordinator.events[0])==bytes((original["pending"] as! [[String:Any]])[0]))
  // Cold delivery uses the committed proof without a new status call.
  let calls=AlongWebView.Coordinator.statusCalls
  AlongWebView.Coordinator.failStatus=true;AlongWebView.Coordinator.failEvent=false
  let cold=HealthEventDelivery();cold.request();await settle()
  let acknowledged=try read()
  precondition((acknowledged["pending"] as! [[String:Any]]).isEmpty)
  precondition(acknowledged["extra"] as? String=="must-survive" && AlongWebView.Coordinator.statusCalls==calls)
  precondition(AlongWebView.Coordinator.events.allSatisfy{$0["event_id"] as? String=="original-event"})
  print("PASS: same identity/bytes, original id ACK, held/lastContent, restart and offline authorization")

  for failure in ["network","user","ready","protocol","connection","aba","queue","enabled"] {
   let state=try seed(),before=try Data(contentsOf:file)
   if failure=="network" {AlongWebView.Coordinator.failStatus=true}
   if failure=="user" {AlongWebView.Coordinator.user="different-user"}
   if failure=="ready" {AlongWebView.Coordinator.statusReady=false}
   if failure=="protocol" {AlongWebView.Coordinator.statusProtocol=0}
   AlongWebView.Coordinator.onStatus={
    if failure=="connection" {AlongConnectionStore.pair=old.merging(["token":String(repeating:"c",count:64)]){_,new in new}}
    if failure=="aba" {
     _=AlongConnectionStore.save(old.merging(["token":String(repeating:"c",count:64)]){_,new in new})
     _=AlongConnectionStore.save(old)
    }
    if failure=="queue" {var changed=state;changed["extra"]="concurrent";try write(changed)}
    if failure=="enabled" {settings.set("disabled",forKey:"along.health.events.binding.v1")}
   }
   try await expectFailure {_=try await mgr.saveConnection(next)}
   if failure != "queue" {precondition(try Data(contentsOf:file)==before,"failure must not mutate outbox")}
   precondition(AlongConnectionStore.pair["baseURL"]==old["baseURL"])
  }
  print("PASS: failed authentication and concurrent connection/queue/enable changes do not migrate")

  // Ordinary identity changes archive, while an unproved address cannot claim a queue.
  for different in ["token","pin","pin-token","pki","unproved"] {
   _=try seed();var candidate=next
   if different=="token" {candidate["token"]=String(repeating:"c",count:64)}
   if different=="pin" || different=="pin-token" {candidate["fingerprint"]=String(repeating:"C",count:64)}
   if different=="pin-token" {candidate["token"]=String(repeating:"c",count:64)}
   if different=="pki" {candidate=AlongConnectionStore.clean(["baseURL":"https://other.example.com","token":old["token"]!])!}
   if different=="pin" || different=="pki" {
    let before=try Data(contentsOf:file)
    try await expectFailure {_=try await mgr.saveConnection(candidate)}
    precondition(try Data(contentsOf:file)==before);precondition(AlongConnectionStore.pair==old)
    continue
   }
   if different=="unproved" {AlongConnectionStore.pair=candidate}
   else {_=try await mgr.saveConnection(candidate)}
   precondition(try read()["verifiedLocalTransports"]==nil)
   _=try await mgr.configure();await settle()
   let active=try read()["pending"] as! [[String:Any]]
   precondition(!active.contains{$0["event_id"] as? String=="original-event"})
  }
  let pki=AlongConnectionStore.clean(["baseURL":"https://first.example.com","token":old["token"]!])!
  _=try seed(pki);var pkiNext=pki;pkiNext["baseURL"]="https://second.example.com"
  let pkiBytes=try Data(contentsOf:file)
  try await expectFailure {_=try await mgr.saveConnection(pkiNext)}
  precondition(try Data(contentsOf:file)==pkiBytes);precondition(AlongConnectionStore.pair==pki)
  var sameOrigin=pki;sameOrigin["fingerprint"]=String(repeating:"D",count:64)
  _=try await mgr.saveConnection(sameOrigin)
  precondition(AlongConnectionStore.pair==pki,"PKI same-origin leaf rotation stays the same pairing")
  pkiNext["token"]=String(repeating:"c",count:64)
  _=try await mgr.saveConnection(pkiNext);precondition(try read()["verifiedLocalTransports"]==nil)
  _=try await mgr.configure();await settle()
  precondition(!(try read()["pending"] as! [[String:Any]]).contains{$0["event_id"] as? String=="original-event"})
  print("PASS: token/pin/public-PKI policy/cross-origin and unverified hash remain isolated")

  _=try seed();AlongConnectionStore.failSave=true
  try await expectFailure {_=try await mgr.saveConnection(next)}
  precondition(AlongConnectionStore.pair==old && (try read()["pending"] as! [[String:Any]]).count==1)
  AlongConnectionStore.failSave=false;AlongWebView.Coordinator.failEvent=false
  let recovered=HealthEventDelivery();recovered.request();await settle()
  precondition((try read()["pending"] as! [[String:Any]]).isEmpty,"old transport must recover failed Keychain commit")
  print("PASS: migration committed before Keychain failure remains recoverable at original address")
  _=try seed();let prior=try Data(contentsOf:file)
  AlongWebView.Coordinator.onStatus={try FileManager.default.setAttributes([.posixPermissions:0o500],ofItemAtPath:file.deletingLastPathComponent().path)}
  try await expectFailure {_=try await mgr.saveConnection(next)}
  try FileManager.default.setAttributes([.posixPermissions:0o700],ofItemAtPath:file.deletingLastPathComponent().path)
  precondition(try Data(contentsOf:file)==prior);precondition(AlongConnectionStore.pair==old)
  print("PASS: atomic migration write failure leaves original queue and connection unchanged")

  // Keep all authorization guards, terminal holds and exact receipt matching.
  _=try seed();_=try await mgr.saveConnection(next)
  settings.set(["sleep"],forKey:"along.health.selectedTypes")
  AlongWebView.Coordinator.failEvent=false;mgr.request();await settle()
  precondition(!AlongWebView.Coordinator.events.contains{$0["event_id"] as? String=="original-event"})
  let held=try read()["held"] as! [[String:Any]]
  precondition(held.contains{$0["event_id"] as? String=="original-event"})
  _=try seed();_=try await mgr.saveConnection(next)
  AlongWebView.Coordinator.failEvent=false;AlongWebView.Coordinator.wrong=true;mgr.request();await settle()
  precondition((try read()["pending"] as! [[String:Any]]).count==1)
  AlongWebView.Coordinator.wrong=false;AlongWebView.Coordinator.reject=true;mgr.request();await settle()
  precondition((try read()["pending"] as! [[String:Any]]).isEmpty && (try read()["held"] as! [[String:Any]]).count==2)
  print("PASS: narrowed permissions hold original event; wrong ACK stays pending; terminal receipt retains complete event")

  // Change transport while an old /events request is in flight. Its ACK can
  // advance only its exact original event, preserving appended events/metadata.
  _=try seed();AlongWebView.Coordinator.failEvent=false
  AlongWebView.Coordinator.onEvent={
   AlongWebView.Coordinator.onEvent=nil
   _=try await mgr.saveConnection(next)
   var live=try read(),pending=live["pending"] as! [[String:Any]]
   var second=pending[0];second["event_id"]="newer-event";pending.append(second);live["pending"]=pending;live["extra"]="newer-metadata";try write(live)
  }
  mgr.request();await settle()
  let afterOldACK=try read()
  precondition(afterOldACK["extra"] as? String=="newer-metadata" && afterOldACK["verifiedLocalTransports"] != nil)
  precondition((afterOldACK["pending"] as! [[String:Any]]).map{$0["event_id"] as! String}==["newer-event"])
  print("PASS: old-address ACK advances exact identity/event only and preserves new transport, queued event and metadata")

  for change in ["payload","user","identity"] {
   _=try seed();AlongWebView.Coordinator.failEvent=false
   AlongWebView.Coordinator.onEvent={
    AlongWebView.Coordinator.onEvent=nil;var state=try read()
    if change=="payload" {var event=(state["pending"] as! [[String:Any]])[0];event["extra"]="new-payload";state["pending"]=[event]}
    if change=="user" {state["user"]="new-user"}
    if change=="identity" {state["binding"]="new-identity";settings.set("new-identity",forKey:"along.health.events.binding.v1")}
    try write(state)
   }
   mgr.request();await settle()
   precondition((try read()["pending"] as! [[String:Any]]).count==1,"old ACK must not remove replaced event/owner")
  }
  print("PASS: stale ACK cannot advance replaced payload, user or identity")
 }
}
`.replaceAll(/^.*precondition.*$/gm,line=>line.slice(0,line.indexOf('precondition'))+line.slice(line.indexOf('precondition')).replace(/\btry(?![!?])/g,'try!')));
  execFileSync('swiftc',['-parse-as-library',fileURLToPath(new URL('../ios/AlongHealth/Sources/DeviceEventQueue.swift',import.meta.url)),fileURLToPath(new URL('../ios/AlongHealth/Sources/HealthModels.swift',import.meta.url)),join(dir,'Check.swift'),'-o',join(dir,'check')],{timeout:60000});
  const run=spawnSync(join(dir,'check'),[dir,'along.synthetic.transport.'+Date.now()],{encoding:'utf8',timeout:30000,env:{...process.env,ALONG_MIGRATE_URL:'https://192.168.10.9:4176',ALONG_MIGRATE_FINGERPRINT:'A'.repeat(64)}});
  assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
  assert.equal((run.stdout.match(/PASS:/g)||[]).length,9,run.stdout);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
