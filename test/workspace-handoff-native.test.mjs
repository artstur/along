import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {fixture} from './helpers/workspace-handoff-fixture.mjs';
import {handoffDigest,signWorkspaceHandoff,canonicalHandoffJSON} from '../host/workspace-handoff.mjs';
const hasSwift=process.platform==='darwin'&&spawnSync('swiftc',['--version']).status===0;
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
function method(source,marker){const a=source.indexOf(marker);assert.ok(a>=0);let b=source.indexOf('{',a),n=1,i=b+1;for(;n;i++){if(source[i]==='{')n++;if(source[i]==='}')n--;}return source.slice(a,i);}

test('real Native handoff preserves exact latest health queue, original namespace and cold journal recovery, with live authority rechecks',{skip:!hasSwift},()=>{
 const dir=mkdtempSync(join(tmpdir(),'along-native-handoff-'));
 try {
  const f=fixture(dir),{c,manifest}=f,oldToken='b'.repeat(64),newToken='c'.repeat(64);
  c.sourceCredentialSHA256=handoffDigest(oldToken);c.targetCredentialSHA256=handoffDigest(newToken);
  const proof=signWorkspaceHandoff(c,{certificatePEM:f.cert,privateKeyPEM:f.key,now:f.now});
  const offer={format:'along-native-workspace-handoff/v1',connection:{baseURL:c.targetOrigin,token:newToken,runtime:'dsh-superagent'},proof,manifestUTF8:canonicalHandoffJSON(manifest)};
  const status={purpose:c.purpose,phase:'target_active',handoffReady:true,eventProtocol:1,syncHighWaterMark:117,hostCompanionSHA256:manifest.hostCompanionSHA256,importReceiptUTF8:f.importReceiptUTF8,
    ...Object.fromEntries(['migrationId','userId','deviceId','manifestSHA256','importReceiptSHA256','snapshotSHA256','syncPrefixSHA256','activationPermitSHA256'].map(k=>[k,c[k]]))};
  writeFileSync(join(dir,'input.json'),JSON.stringify({offer,status,sourcePin:handoffDigest(Buffer.from(proof.certificateDER,'base64')).toUpperCase(),nonce:c.nonce}),{mode:0o600});
  const shell=read('../ios/AlongHealth/Sources/AlongShellView.swift'),source=read('../ios/AlongHealth/Sources/HealthKitReader.swift');
  const core=source.slice(source.indexOf('@MainActor final class HealthEventDelivery {')).replaceAll('UserDefaults.standard','TestEnvironment.settings')
   .replace(/let dir = try FileManager.default.url\(for:[^\n]+/,'let dir = URL(fileURLWithPath: CommandLine.arguments[1])')
   .replaceAll('attributes: [.protectionKey: FileProtectionType.complete]','attributes: nil').replaceAll('options: [.atomic, .completeFileProtection]','options: [.atomic]');
  const proofCore=read('../ios/AlongHealth/Sources/WorkspaceHandoff.swift').split('// Only Native reads this service.')[0];
  const methods=['bindingScopeId','trustPolicy','isPrivateIPv4','scopeSeed','hostAccepted','clean','permitsPairedTransport'].map(n=>method(shell,`    static func ${n}(`)).join('\n');
  const collectors=read('../ios/AlongHealth/Sources/DeviceDataCollectors.swift').split('@MainActor struct OKXDeviceDataCollector')[0];
  writeFileSync(join(dir,'Check.swift'),`import Foundation
import CryptoKit
import Security
${proofCore}
@MainActor enum TestEnvironment {static let settings=UserDefaults(suiteName:CommandLine.arguments[2])!}
@MainActor final class UIApplication {enum State {case active,background};static let shared=UIApplication();var applicationState=State.background;var isProtectedDataAvailable=true}
enum AgentBridgeError:Error {case invalidConfiguration;case receipt([String:Any])}
@MainActor enum AlongConnectionStore {
 static let legacyPinPolicy="legacy-local-pin-v1",systemTrustPolicy="system-pki-v1"
 static var pair=[String:String](),failSave=false,saveRevision:UInt64=0
 ${methods}
 static func load()->[String:String]? {pair}
 static func save(_ value:[String:Any])->[String:String]? {guard !failSave,let c=clean(value) else{return nil};pair=c;saveRevision &+= 1;return c}
}
// Only secret I/O is mocked. No real Mac Keychain item is read or written by this regression.
@MainActor enum WorkspaceHandoffVault {
 static var records=[String:[String:Any]](),fail=false
 static func save(_ record:[String:Any],id:String)throws {if fail{throw WorkspaceHandoffError.secretUnavailable};records[id]=record}
 static func load(_ id:String)throws->[String:Any] {guard let record=records[id] else{throw WorkspaceHandoffError.secretUnavailable};return record}
}
@MainActor final class BackgroundHealthReviews {static let shared=BackgroundHealthReviews();var usesEventProtocol:()->Bool={false};func disarm(){};func configureObservers(){}}
@MainActor final class HealthKitReader {
 static var snapshot:HealthSummary {HealthSummary(selected:[.steps],capturedAt:ISO8601DateFormatter().date(from:"2026-11-24T04:00:00Z")!,steps:1000)}
 func observeChanges(_ s:Set<HealthMetric>,onChange:@escaping(@escaping()->Void)->Void){};func updateBackgroundDelivery(_ s:Set<HealthMetric>){}
 func read(_ s:Set<HealthMetric>,requestPermission:Bool,includeContext:Bool)async throws->HealthSummary {Self.snapshot}
}
@MainActor enum AlongWebView {enum Coordinator {
 static var status=[String:Any](),onStatus:(()async throws->Void)?,onEvent:(()async throws->Void)?,failStatus=false,eventCalls=0
 static func notificationOperation(_ x:[String:Any])async throws->[String:Any] {[:]}
 static func agentRequest(_ input:[String:Any],background:Bool=false,privateWorkspaceHandoffRequest:Bool=false)async throws->[String:Any] {
  let path=input["path"] as! String
  if path=="/workspace-handoff/status" {precondition(privateWorkspaceHandoffRequest);try await onStatus?();if failStatus{throw WorkspaceHandoffError.invalidState};return status}
  if path=="/connection/status" {return ["eventProtocol":1,"ready":true,"userId":"u_12345678"]}
  if path=="/events" {eventCalls+=1;try await onEvent?();return ["status":"accepted","event_id":(input["body"] as! [String:Any])["event_id"]!]}
  throw WorkspaceHandoffError.invalidState
 }
}}
${collectors}
${core}
@main struct Fixture {
 @MainActor static let settings=TestEnvironment.settings
 @MainActor static var input:[String:Any]=[:]
 @MainActor static var file:URL {URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("AlongHealthEvents/outbox.json")}
 @MainActor static var old:[String:String] {AlongConnectionStore.clean(["baseURL":"https://192.168.10.2:4176","token":String(repeating:"b",count:64),"fingerprint":input["sourcePin"]!])!}
 @MainActor static var next:[String:String] {AlongConnectionStore.clean((input["offer"] as! [String:Any])["connection"] as! [String:Any])!}
 @MainActor static func readState()throws->[String:Any] {try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]}
 @MainActor static func write(_ s:[String:Any])throws {try JSONSerialization.data(withJSONObject:s,options:.sortedKeys).write(to:file,options:.atomic)}
 @MainActor static func reset()throws {
  try? FileManager.default.removeItem(at:file.deletingLastPathComponent());try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
  AlongConnectionStore.pair=old;AlongConnectionStore.failSave=false;WorkspaceHandoffVault.fail=false;WorkspaceHandoffVault.records=[:]
  AlongWebView.Coordinator.status=input["status"] as! [String:Any];AlongWebView.Coordinator.onStatus=nil;AlongWebView.Coordinator.onEvent=nil;AlongWebView.Coordinator.failStatus=false;AlongWebView.Coordinator.eventCalls=0
  let binding=WorkspaceHandoffProof.hash(AlongConnectionStore.scopeSeed(old)!)
  settings.set(binding,forKey:"along.health.events.binding.v1");settings.set(true,forKey:"along.health.contextReview.v1");settings.set(["steps"],forKey:"along.health.selectedTypes")
  let summaries=HealthKitReader.snapshot.eventSummaries()
  try write(["binding":binding,"user":"u_12345678","pending":[["event_id":"original-event","event_type":"along.health_summary_updated","payload":["summaries":summaries]]],
    "held":[["event_id":"held-original"]],"lastContent":try HealthEventOutbox.content(summaries),"extra":"preserve",
    "workspaceHandoffChallenge":["nonce":input["nonce"]!,"targetOrigin":"https://cloud.example.com","sourceCredentialSHA256":WorkspaceHandoffProof.hash(String(repeating:"b",count:64)),"expiresAt":Int(Date().timeIntervalSince1970)+1000]])
 }
 @MainActor static func fail(_ operation:()async throws->Void)async {var failed=false;do{try await operation()}catch{failed=true};precondition(failed)}
 @MainActor static func assertQueue(_ count:Int)throws {
  let s=try readState();precondition((s["pending"] as! [[String:Any]]).count==count);precondition((s["held"] as! [[String:Any]])[0]["event_id"] as? String=="held-original");precondition(s["extra"] as? String=="preserve")
 }
 @MainActor static func main()async throws {
  defer{settings.removePersistentDomain(forName:CommandLine.arguments[2])}
  input=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("input.json"))) as! [String:Any]
  let mgr=HealthEventDelivery(),offer=input["offer"] as! [String:Any]
  try reset();let challenge=try mgr.prepareWorkspaceHandoff(targetOrigin:"https://cloud.example.com")
  precondition(challenge["token"]==nil && (challenge["nonce"] as! String).count==64)
  for bad in ["http://cloud.example.com","https://192.168.3.4:4176","https://cloud.example.com/path"] {await fail{_ = try mgr.prepareWorkspaceHandoff(targetOrigin:bad)}}
  // Wrong nonce and unready actual Source leave connection and original outbox untouched.
  await fail{_ = try await mgr.commitWorkspaceHandoff(offer)};precondition(AlongConnectionStore.pair==old);try assertQueue(1)
  try reset();AlongWebView.Coordinator.status["handoffReady"]=false;await fail{_ = try await mgr.commitWorkspaceHandoff(offer)};try assertQueue(1);precondition(WorkspaceHandoffVault.records.isEmpty)
  try reset();AlongWebView.Coordinator.status["phase"]="target_staged";await fail{_ = try await mgr.commitWorkspaceHandoff(offer)};precondition(AlongConnectionStore.pair==old)
  // Legal appends during both active checks must survive; no stale queue snapshot is written.
  try reset();var appended=false
  AlongWebView.Coordinator.onStatus={if !appended {appended=true;var s=try readState();var p=s["pending"] as! [[String:Any]];p.append(["event_id":"legitimate-added","payload":["summaries":HealthKitReader.snapshot.eventSummaries()]]);s["pending"]=p;try write(s)}}
  let oldScope=WorkspaceHandoffProof.hash([AlongConnectionStore.scopeSeed(old)!,"u_12345678"].joined(separator:"\\n"))
  let result=try await mgr.commitWorkspaceHandoff(offer);precondition(AlongConnectionStore.pair==next);try assertQueue(2)
  precondition(mgr.notificationScope(next,user:"u_12345678")==oldScope);precondition((result["workspaceHandoff"] as! [String:Any])["deviceId"] as? String=="d_12345678")
  _ = try await mgr.commitWorkspaceHandoff(offer);try assertQueue(2)
  // Saving credentials can fail only after the durable prepared journal. Cold lightweight
  // launch cannot switch source; full recovery still requires the authenticated live receipt.
  try reset();AlongConnectionStore.failSave=true;await fail{_ = try await mgr.commitWorkspaceHandoff(offer)}
  precondition(AlongConnectionStore.pair==old);let prepared=try readState()["workspaceHandoff"] as! [String:Any];precondition(prepared["phase"] as? String=="prepared")
  AlongConnectionStore.failSave=false;AlongWebView.Coordinator.failStatus=true
  try await HealthEventDelivery().recoverWorkspaceHandoff(onlyIfAlreadyTarget:true);precondition(AlongConnectionStore.pair==old)
  await fail{try await HealthEventDelivery().recoverWorkspaceHandoff()};precondition(AlongConnectionStore.pair==old);try assertQueue(1)
  AlongWebView.Coordinator.failStatus=false;try await HealthEventDelivery().recoverWorkspaceHandoff();precondition(AlongConnectionStore.pair==next);try assertQueue(1)
  // Crash after Keychain commit but before journal finalization can finish locally offline.
  var state=try readState(),record=state["workspaceHandoff"] as! [String:Any];record["phase"]="prepared";state["workspaceHandoff"]=record;try write(state)
  AlongWebView.Coordinator.failStatus=true;try await HealthEventDelivery().recoverWorkspaceHandoff(onlyIfAlreadyTarget:true)
  let committed=try readState()["workspaceHandoff"] as! [String:Any];precondition(committed["phase"] as? String=="committed");try assertQueue(1)
  // A credential-save ABA during a status wait invalidates the commit even when text returns.
  try reset();AlongWebView.Coordinator.onStatus={_ = AlongConnectionStore.save(old)}
  await fail{_ = try await mgr.commitWorkspaceHandoff(offer)};precondition(AlongConnectionStore.pair==old);precondition(WorkspaceHandoffVault.records.isEmpty)
  // An old-Mac ACK in flight during cutover is not a cloud persistence receipt.
  try reset();var cutover=false;AlongWebView.Coordinator.onEvent={if !cutover {cutover=true;_ = try await mgr.commitWorkspaceHandoff(offer)}}
  await withCheckedContinuation { continuation in mgr.request {continuation.resume()} }
  precondition(AlongConnectionStore.pair==next);try assertQueue(1)
  AlongWebView.Coordinator.onEvent=nil
  await withCheckedContinuation { continuation in mgr.request {continuation.resume()} }
  try assertQueue(0)
  // Native reconfigure after commit keeps the original queue and identity; no previous-* archive.
  try reset();_ = try await mgr.commitWorkspaceHandoff(offer);_ = try await mgr.configure();try assertQueue(1)
  let files=try FileManager.default.contentsOfDirectory(atPath:file.deletingLastPathComponent().path);precondition(files.allSatisfy{!$0.hasPrefix("previous-")})
  print("PASS latest queue preservation, active authority, prepared recovery, ABA, namespace, no archive")
 }
}`);
  const binary=join(dir,'check');execFileSync('swiftc',['-parse-as-library',fileURLToPath(new URL('../ios/AlongHealth/Sources/DeviceEventQueue.swift',import.meta.url)),
   fileURLToPath(new URL('../ios/AlongHealth/Sources/HealthModels.swift',import.meta.url)),join(dir,'Check.swift'),'-o',binary],{timeout:90000});
  assert.match(execFileSync(binary,[dir,'along.handoff.test.'+Date.now()],{encoding:'utf8',timeout:30000}),/PASS latest queue preservation/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
