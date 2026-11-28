import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const hasSwift=process.platform==='darwin'&&spawnSync('swiftc',['--version']).status===0;
const shell=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
function method(source,marker) {
 const start=source.indexOf(marker);assert.ok(start>=0,marker);
 const brace=source.indexOf('{',start);let depth=1,end=brace+1;
 for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;if(source[end]==='}')depth--;}
 return source.slice(start,end);
}

test('retiring the Mac preserves its health outbox while cloud transport retains delivery and isolation',{skip:!hasSwift},()=>{
 const source=readFileSync(new URL('../ios/AlongHealth/Sources/HealthKitReader.swift',import.meta.url),'utf8');
 const core=source.slice(source.indexOf('@MainActor final class HealthEventDelivery {'))
  .replaceAll('UserDefaults.standard','TestEnvironment.settings')
  .replace(/let dir = try FileManager.default.url\(for:[^\n]+/,'let dir = URL(fileURLWithPath: CommandLine.arguments[1])')
  .replaceAll('attributes: [.protectionKey: FileProtectionType.complete]','attributes: nil')
  .replaceAll('options: [.atomic, .completeFileProtection]','options: [.atomic]');
 const collectors=readFileSync(new URL('../ios/AlongHealth/Sources/DeviceDataCollectors.swift',import.meta.url),'utf8').split('@MainActor struct OKXDeviceDataCollector')[0];
 const methods=['bindingScopeId','cloudHostAccepted','scopeSeed','clean','permitsPairedTransport','savePairedConnection'].map(name=>method(shell,`    static func ${name}(`)).join('\n');
 const dir=mkdtempSync(join(tmpdir(),'along-health-transport-'));
 try {
  writeFileSync(join(dir,'Check.swift'),`import Foundation
import CryptoKit
@MainActor enum TestEnvironment {static let settings=UserDefaults(suiteName:CommandLine.arguments[2])!}
@MainActor final class UIApplication {
 enum State {case active,background};static let shared=UIApplication();var applicationState=State.background;var isProtectedDataAvailable=true
}
enum AgentBridgeError:Error {case invalidConfiguration;case receipt([String:Any])}
@MainActor enum AlongConnectionStore {
 static let legacyKey="along.test.legacy",systemTrustPolicy="system-pki-v1"
 static var pair=[String:String](),failSave=false
 ${methods}
 static func storedConnection()->[String:Any]? {pair}
 static func load()->[String:String]? {clean(pair)}
 static func save(_ value:[String:Any])->[String:String]? {guard !failSave,let c=clean(value) else{return nil};pair=c;return c}
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
 static func agentRequest(_ input:[String:Any],background:Bool=false)async throws->[String:Any] {
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
@main struct Fixture {
 @MainActor static let settings=TestEnvironment.settings
 @MainActor static var file:URL {URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("AlongHealthEvents/outbox.json")}
 @MainActor static func bytes(_ value:[String:Any])throws->Data {try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])}
 @MainActor static func read()throws->[String:Any] {try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]}
 @MainActor static func write(_ value:[String:Any])throws {try bytes(value).write(to:file,options:.atomic)}
 @MainActor static func hash(_ c:[String:String])->String {SHA256.hash(data:Data(AlongConnectionStore.scopeSeed(c)!.utf8)).map{String(format:"%02x",$0)}.joined()}
 @MainActor static var retired:[String:String] {["baseURL":"https://192.168.10.2:4176","token":String(repeating:"b",count:64),"fingerprint":String(repeating:"A",count:64)]}
 @MainActor static var cloud:[String:String] {AlongConnectionStore.clean(["baseURL":"https://along.example.com","token":String(repeating:"a",count:64)])!}
 @MainActor static func settle()async {for _ in 0..<30 {try? await Task.sleep(for:.milliseconds(3))}}
 @MainActor static func seed(_ c:[String:String]?=nil, binding:String?=nil)throws->[String:Any] {
  let c=c ?? cloud
  AlongConnectionStore.pair=c;AlongConnectionStore.failSave=false
  AlongWebView.Coordinator.user="synthetic-user";AlongWebView.Coordinator.failStatus=false;AlongWebView.Coordinator.failEvent=true
  AlongWebView.Coordinator.wrong=false;AlongWebView.Coordinator.reject=false;AlongWebView.Coordinator.statusReady=true;AlongWebView.Coordinator.statusProtocol=1;AlongWebView.Coordinator.onEvent=nil;AlongWebView.Coordinator.onStatus=nil;AlongWebView.Coordinator.events=[]
  let owner=binding ?? hash(c)
  settings.set(owner,forKey:"along.health.events.binding.v1")
  settings.set(true,forKey:"along.health.contextReview.v1");settings.set(["steps"],forKey:"along.health.selectedTypes")
  let rows=HealthKitReader.snapshot.eventSummaries()
  let event:[String:Any]=["event_id":"original-event","event_type":"along.health_summary_updated","payload":["summaries":rows]]
  let state:[String:Any]=["binding":owner,"user":"synthetic-user","pending":[event],"held":[["retained":"held-event","receipt":["status":"rejected"]]],"lastContent":try HealthEventOutbox.content(rows),"extra":"must-survive"]
  try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
  try write(state);return state
 }
 @MainActor static func main()async throws {
  defer {settings.removePersistentDomain(forName:CommandLine.arguments[2])}
  let mgr=HealthEventDelivery()
  _=try seed(retired,binding:"original-device")
  let original=try Data(contentsOf:file), reads=HealthKitReader.reads
  precondition(AlongConnectionStore.load()==nil)
  mgr.request();await settle()
  precondition(AlongWebView.Coordinator.events.isEmpty && HealthKitReader.reads==reads)
  precondition(try Data(contentsOf:file)==original)
  precondition(mgr.cachedWorkspaceBinding(retired).isEmpty)
  var local=retired;local["baseURL"]="https://192.168.10.9:4176"
  precondition(AlongConnectionStore.savePairedConnection(local)==nil)
  local["baseURL"]=cloud["baseURL"]
  precondition(AlongConnectionStore.savePairedConnection(local)==nil)
  precondition(AlongConnectionStore.pair==retired && (try Data(contentsOf:file))==original)
  print("PASS: retirement does not collect, send, rewrite or reuse old credentials")

  _=try seed()
  var cloudNext=cloud;cloudNext["baseURL"]="https://second.example.com"
  let cloudBytes=try Data(contentsOf:file)
  precondition(AlongConnectionStore.savePairedConnection(cloudNext)==nil)
  precondition(try Data(contentsOf:file)==cloudBytes)
  var refreshed=cloud;refreshed["fingerprint"]=String(repeating:"D",count:64)
  precondition(AlongConnectionStore.savePairedConnection(refreshed)==cloud)
  precondition(AlongConnectionStore.pair==cloud)
  precondition(try Data(contentsOf:file)==cloudBytes)
  cloudNext["token"]=String(repeating:"c",count:64)
  precondition(AlongConnectionStore.savePairedConnection(cloudNext) != nil)
  _=try await mgr.configure();await settle()
  precondition(!(try read()["pending"] as! [[String:Any]]).contains{$0["event_id"] as? String=="original-event"})
  print("PASS: cloud leaf refresh keeps identity, and cross-origin pairing isolates queues")

  _=try seed()
  AlongConnectionStore.failSave=true
  precondition(AlongConnectionStore.savePairedConnection(cloudNext)==nil)
  precondition(AlongConnectionStore.pair==cloud)
  precondition(try Data(contentsOf:file)==cloudBytes)
  AlongConnectionStore.failSave=false
  AlongWebView.Coordinator.failStatus=true;AlongWebView.Coordinator.failEvent=false
  let cold=HealthEventDelivery();cold.request();await settle()
  precondition((try read()["pending"] as! [[String:Any]]).isEmpty)
  print("PASS: failed Keychain write leaves the cloud outbox retryable")

  // A previously installed cloud binding uses the original outbox and notification IDs.
  let oldScope=String(repeating:"e",count:64)
  let tokenDigest=SHA256.hash(data:Data(cloud["token"]!.utf8)).map {String(format:"%02x",$0)}.joined()
  for phase in ["committed","prepared"] {
   var state=try seed(binding:"original-device")
   let record=["phase":phase,"binding":"original-device","userId":"synthetic-user",
               "targetBaseURL":cloud["baseURL"]!,"targetBindingScopeId":cloud["bindingScopeId"]!,
               "targetCredentialSHA256":tokenDigest,"notificationScope":oldScope]
   for field in ["binding","userId","targetBaseURL","targetBindingScopeId","targetCredentialSHA256","notificationScope"] {
    var wrong=record;wrong[field]="wrong"
    state["workspaceHandoff"]=wrong;try write(state)
    precondition(mgr.notificationScope(cloud,user:"synthetic-user")==nil)
    precondition(mgr.cachedWorkspaceBinding(cloud).isEmpty)
   }
   state["workspaceHandoff"]=record;try write(state)
   precondition(mgr.notificationScope(cloud,user:"synthetic-user")==oldScope)
   precondition(mgr.notificationScope(cloud,user:"different-user")==nil)
   precondition(mgr.cachedWorkspaceBinding(cloud)["userId"]=="synthetic-user")
   precondition(mgr.cachedWorkspaceBinding(cloudNext).isEmpty)
   AlongWebView.Coordinator.failEvent=false;mgr.request();await settle()
   precondition(AlongWebView.Coordinator.events.map{$0["event_id"] as? String}==["original-event"])
   precondition((try read()["pending"] as! [[String:Any]]).isEmpty)
  }
  print("PASS: existing cloud owner keeps notifications and sends the original queued event")

  // Keep all authorization guards, terminal holds and exact receipt matching.
  _=try seed()
  settings.set(["sleep"],forKey:"along.health.selectedTypes")
  AlongWebView.Coordinator.failEvent=false;mgr.request();await settle()
  precondition(!AlongWebView.Coordinator.events.contains{$0["event_id"] as? String=="original-event"})
  let held=try read()["held"] as! [[String:Any]]
  precondition(held.contains{$0["event_id"] as? String=="original-event"})
  _=try seed()
  AlongWebView.Coordinator.failEvent=false;AlongWebView.Coordinator.wrong=true;mgr.request();await settle()
  precondition((try read()["pending"] as! [[String:Any]]).count==1)
  AlongWebView.Coordinator.wrong=false;AlongWebView.Coordinator.reject=true;mgr.request();await settle()
  precondition((try read()["pending"] as! [[String:Any]]).isEmpty && (try read()["held"] as! [[String:Any]]).count==2)
  print("PASS: narrowed permissions hold original event; wrong ACK stays pending; terminal receipt retains complete event")

  // A concurrent append must survive the original event acknowledgement.
  _=try seed();AlongWebView.Coordinator.failEvent=false
  AlongWebView.Coordinator.onEvent={
   AlongWebView.Coordinator.onEvent=nil
   var live=try read(),pending=live["pending"] as! [[String:Any]]
   var second=pending[0];second["event_id"]="newer-event";pending.append(second);live["pending"]=pending;live["extra"]="newer-metadata";try write(live)
   AlongWebView.Coordinator.onEvent={throw AgentBridgeError.invalidConfiguration}
  }
  mgr.request();await settle()
  let afterOldACK=try read()
  precondition(afterOldACK["extra"] as? String=="newer-metadata")
  precondition((afterOldACK["pending"] as! [[String:Any]]).map{$0["event_id"] as! String}==["newer-event"])
  print("PASS: ACK advances the exact original event and preserves later events and metadata")

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
  const run=spawnSync(join(dir,'check'),[dir,'along.synthetic.transport.'+Date.now()],{encoding:'utf8',timeout:30000});
  assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
  assert.equal((run.stdout.match(/PASS:/g)||[]).length,7,run.stdout);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
