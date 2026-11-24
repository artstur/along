import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const hasSwift=process.platform==='darwin'&&spawnSync('swift',['--version']).status===0;
const shell=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
const health=readFileSync(new URL('../ios/AlongHealth/Sources/HealthKitReader.swift',import.meta.url),'utf8');
function method(source,marker) {
  const start=source.indexOf(marker);assert.ok(start>=0,marker+' must exist in shipped source');
  const brace=source.indexOf('{',start);let depth=1,end=brace+1;
  for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;if(source[end]==='}')depth--;}
  assert.equal(depth,0);return source.slice(start,end);
}

test('native offline owner proof reads only an existing full-binding outbox and never collects, configures or modifies it',{skip:!hasSwift},()=>{
  const proof=method(health,'    func cachedWorkspaceBinding(');
  const stateURL=method(health.slice(health.indexOf('@MainActor final class HealthEventDelivery {')),'    private func stateURL(');
  const load=method(health.slice(health.indexOf('@MainActor final class HealthEventDelivery {')),'    private func load(');
  assert.match(stateURL,/create: createDirectory/,'the read path cannot create Application Support');
  assert.match(stateURL,/if createDirectory \{/,'directory writes must be confined to the write path');
  assert.match(load,/stateURL\(createDirectory: createDirectory\)/);
  assert.match(shell,/if body\["action"\] as\? String == "workspace", origin.protocol != "along" \|\| origin.host != "app"/);
  assert.match(shell,/case "workspace":[\s\S]*?cachedWorkspaceBinding\(saved\)/);
  const dir=mkdtempSync(join(tmpdir(),'along-offline-binding-'));
  try {
    const source=`import Foundation
import CryptoKit

enum AlongConnectionStore {
  static let legacyPinPolicy="legacy-local-pin-v1",systemTrustPolicy="system-pki-v1"
  ${method(shell,'    static func trustPolicy(')}
  ${method(shell,'    static func isPrivateIPv4(')}
  ${method(shell,'    static func bindingScopeId(')}
  ${method(shell,'    static func scopeSeed(')}
}
final class UIApplication { static let shared=UIApplication(); var isProtectedDataAvailable=true }
final class FakeDefaults {
  var enabled:String?; var writes=0
  func string(forKey:String)->String? { enabled }
}
final class Probe {
  let defaults=FakeDefaults(), enabledKey="enabled"
  var state:[String:Any]=[:], reads=0, failRead=false
  func load(createDirectory:Bool=true)throws->[String:Any] {
    precondition(!createDirectory,"offline proof must never create a state directory")
    reads+=1
    if failRead { throw NSError(domain:"locked",code:1) }
    return state
  }
  ${method(health,'    private func localCredential(')}
  ${method(health,'    private func owns(')}
  ${proof}
}
let old:[String:String]=["baseURL":"https://192.168.1.2:4176","fingerprint":String(repeating:"A",count:64),"token":String(repeating:"b",count:64)]
let scope=AlongConnectionStore.bindingScopeId(baseURL:old["baseURL"]!,token:old["token"]!)!
var current=old;current["bindingScopeId"]=scope
let seed=AlongConnectionStore.scopeSeed(current)!
let binding=SHA256.hash(data:Data(seed.utf8)).map{String(format:"%02x",$0)}.joined()
let p=Probe();p.defaults.enabled=binding
p.state=["binding":binding,"user":"u_original","pending":[["event_id":"original-event"]],"lastContent":"original-content","held":["original-held"]]
let original=try JSONSerialization.data(withJSONObject:p.state,options:[.sortedKeys])
let proof=p.cachedWorkspaceBinding(current)
precondition(proof==["baseURL":old["baseURL"]!,"bindingScopeId":scope,"userId":"u_original"])
precondition(!proof.keys.contains("pending") && !proof.keys.contains("token"))
for field in ["baseURL","token","fingerprint"] {
  var changed=current
  changed[field]=field=="baseURL" ? "https://192.168.1.9:4176" : String(repeating:"c",count:64)
  changed["bindingScopeId"]=AlongConnectionStore.bindingScopeId(baseURL:changed["baseURL"]!,token:changed["token"]!)
  precondition(p.cachedWorkspaceBinding(changed).isEmpty,"full original binding must match \\(field)")
}
var unknown=current;unknown["bindingScopeId"]=String(repeating:"d",count:64)
precondition(p.cachedWorkspaceBinding(unknown).isEmpty)
p.defaults.enabled="other-binding";precondition(p.cachedWorkspaceBinding(current).isEmpty)
p.defaults.enabled=nil;precondition(p.cachedWorkspaceBinding(current).isEmpty)
p.defaults.enabled=binding;p.state["binding"]="other-binding";precondition(p.cachedWorkspaceBinding(current).isEmpty)
p.state["binding"]=binding
let kept=p.state;p.state=[:];precondition(p.cachedWorkspaceBinding(current).isEmpty);p.state=kept
for badUser in ["", "../other", String(repeating:"x",count:97)] { p.state["user"]=badUser;precondition(p.cachedWorkspaceBinding(current).isEmpty) }
p.state["user"]="u_original";p.failRead=true;precondition(p.cachedWorkspaceBinding(current).isEmpty);p.failRead=false
UIApplication.shared.isProtectedDataAvailable=false;let reads=p.reads;precondition(p.cachedWorkspaceBinding(current).isEmpty);precondition(p.reads==reads)
UIApplication.shared.isProtectedDataAvailable=true
let after=try JSONSerialization.data(withJSONObject:p.state,options:[.sortedKeys]);precondition(after==original)
precondition(p.defaults.enabled==binding && p.defaults.writes==0)
print("PASS: same binding owner only; origin/token/pin/scope/enabled/user/locked/read failure rejected; outbox and enabled unchanged")
`;
    const file=join(dir,'proof.swift');writeFileSync(file,source);
    const output=execFileSync('swift',[file],{encoding:'utf8'});
    assert.match(output,/PASS: same binding owner only/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the actual native outbox read path leaves missing directories, existing files and corrupt JSON unchanged',{skip:!hasSwift},()=>{
  const native=health.slice(health.indexOf('@MainActor final class HealthEventDelivery {'));
  const dir=mkdtempSync(join(tmpdir(),'along-offline-files-'));
  try {
    const source=`import Foundation
import CryptoKit

enum AgentBridgeError:Error {case invalidConfiguration}
enum AlongConnectionStore {
  static let legacyPinPolicy="legacy-local-pin-v1",systemTrustPolicy="system-pki-v1"
  ${method(shell,'    static func trustPolicy(')}
  ${method(shell,'    static func isPrivateIPv4(')}
  ${method(shell,'    static func bindingScopeId(')}
  ${method(shell,'    static func scopeSeed(')}
}
final class UIApplication { static let shared=UIApplication(); var isProtectedDataAvailable=true }
// Restrict the real source to a disposable support directory and trap every mutating FileManager API.
final class FileManager {
 static let \`default\`=FileManager()
 let root=URL(fileURLWithPath:CommandLine.arguments[1]);var writes=0
 func url(for:Foundation.FileManager.SearchPathDirectory,in:Foundation.FileManager.SearchPathDomainMask,appropriateFor:URL?,create:Bool)throws->URL {
  precondition(!create,"read-only proof tried to create Application Support");return root
 }
 func createDirectory(at:URL,withIntermediateDirectories:Bool,attributes:[FileAttributeKey:Any]?)throws {
  writes+=1;throw AgentBridgeError.invalidConfiguration
 }
}
final class FakeDefaults { var enabled:String?;func string(forKey:String)->String? {enabled} }
final class Probe {
 let defaults=FakeDefaults(),enabledKey="enabled"
 ${method(native,'    private func stateURL(')}
 ${method(native,'    private func load(')}
 ${method(native,'    private func localCredential(')}
 ${method(native,'    private func owns(')}
 ${method(native,'    func cachedWorkspaceBinding(')}
}
let base="https://192.168.1.2:4176",token=String(repeating:"b",count:64)
let scope=AlongConnectionStore.bindingScopeId(baseURL:base,token:token)!
let c=["baseURL":base,"token":token,"fingerprint":String(repeating:"A",count:64),"bindingScopeId":scope]
let binding=SHA256.hash(data:Data(AlongConnectionStore.scopeSeed(c)!.utf8)).map{String(format:"%02x",$0)}.joined()
let probe=Probe();probe.defaults.enabled=binding
let root=FileManager.default.root,folder=root.appendingPathComponent("AlongHealthEvents"),file=folder.appendingPathComponent("outbox.json")
let fs=Foundation.FileManager.default
precondition(!fs.fileExists(atPath:root.path))
precondition(probe.cachedWorkspaceBinding(c).isEmpty)
precondition(!fs.fileExists(atPath:root.path),"missing directory was created")
try fs.createDirectory(at:folder,withIntermediateDirectories:true)
let state:[String:Any]=["binding":binding,"user":"original_user","pending":[["event_id":"original-event","payload":["synthetic":true]]],"held":[],"lastContent":"original-content"]
let bytes=try JSONSerialization.data(withJSONObject:state,options:[.sortedKeys]);try bytes.write(to:file)
let before=try fs.attributesOfItem(atPath:file.path),beforeDir=try fs.attributesOfItem(atPath:folder.path)
let excluded=try folder.resourceValues(forKeys:[.isExcludedFromBackupKey]).isExcludedFromBackup
for _ in 0..<3 {precondition(probe.cachedWorkspaceBinding(c)["userId"]=="original_user")}
let after=try fs.attributesOfItem(atPath:file.path),afterDir=try fs.attributesOfItem(atPath:folder.path)
let same=try Data(contentsOf:file);precondition(same==bytes)
for key in [FileAttributeKey.modificationDate,.posixPermissions,.size] {precondition(String(describing:before[key])==String(describing:after[key]))}
precondition(String(describing:beforeDir[.modificationDate])==String(describing:afterDir[.modificationDate]))
let afterExcluded=try folder.resourceValues(forKeys:[.isExcludedFromBackupKey]).isExcludedFromBackup
precondition(excluded==afterExcluded)
for bad in [Data("{broken".utf8),Data("[]".utf8)] {
 try bad.write(to:file);precondition(probe.cachedWorkspaceBinding(c).isEmpty)
 let kept=try Data(contentsOf:file);precondition(kept==bad)
}
precondition(FileManager.default.writes==0 && probe.defaults.enabled==binding)
print("PASS: real stateURL/load/proof left missing directories, bytes, attributes, enabled and malformed queue untouched")
`;
    const file=join(dir,'read.swift');writeFileSync(file,source);
    const output=execFileSync('swift',[file,join(dir,'absent-support')],{encoding:'utf8'});
    assert.match(output,/PASS: real stateURL\/load\/proof/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
