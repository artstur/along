import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:https';
import {createHash,X509Certificate} from 'node:crypto';
import {makeTestCa} from './cloud-ca-fixture.mjs';
const execAsync=promisify(execFile);
const hasSwift=process.platform==='darwin'&&spawnSync('swiftc',['--version']).status===0;
function block(source,marker) {
 const start=source.indexOf(marker);assert.ok(start>=0,marker);
 const brace=source.indexOf('{',start);let depth=1,end=brace+1;
 for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;if(source[end]==='}')depth--;}
 return source.slice(start,end);
}

test('actual native agentRequest authenticates the status through its pinned TLS delegate before sending application bytes',{skip:!hasSwift},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'along-transport-tls-'));
 let server;
 try {
  makeTestCa(dir,'127.0.0.1');
  const cert=readFileSync(join(dir,'leaf.crt'));
  const pin=createHash('sha256').update(new X509Certificate(cert).raw).digest('hex').toUpperCase();
  const source=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
  const native=block(source,'        static func agentRequest(');
  const pinned=block(source,'final class PinnedAgentDelegate:');
  const system=block(source,'final class SystemTrustAgentDelegate:');
  writeFileSync(join(dir,'TLS.swift'),`import Foundation
import CryptoKit
import Security
import CFNetwork
// The fixture has only a loopback listener. Adapt address acceptance/routing to
// loopback; the complete production HTTP implementation and both TLS delegates
// below are unmodified. No system trust store, Host, device or real token is used.
enum AlongConnectionStore {
 static let legacyPinPolicy="legacy-local-pin-v1",systemTrustPolicy="system-pki-v1"
 static func hostAccepted(_ host:String)->Bool {host=="127.0.0.1"}
 static func trustPolicy(forHost host:String)->String {host=="127.0.0.1" && CommandLine.arguments.count>3 ? systemTrustPolicy : legacyPinPolicy}
 static func load()->[String:String]? {
  CommandLine.arguments.count>3 ? ["baseURL":"https://192.168.10.2:4176","token":"synthetic-token-only","fingerprint":CommandLine.arguments[2]] : nil
 }
 ${block(source,'    static func bindingScopeId(')}
 ${block(source,'    static func permitsPairedTransport(')}
 ${block(source,'    static func pinnedFingerprint(')}
 ${block(source,'    static func acceptsPin(')}
}
enum AgentBridgeError:Error {
 case invalidConfiguration,invalidResponse,receipt([String:Any]),server(String)
 static func transportMessage(_ error:Error)->String? {nil}
}
${pinned}
${system}
enum Probe {
${native}
}
@main struct Fixture {
 static func main()async throws {
  let input:[String:Any]=["baseURL":CommandLine.arguments[1],"fingerprint":CommandLine.arguments[2],"token":"synthetic-token-only","path":"/connection/status","body":["runtime":"dsh-superagent"]]
  do {
   let status=try await Probe.agentRequest(input,background:true)
   precondition(status["userId"] as? String=="synthetic-user" && status["ready"] as? Bool==true)
   print("authenticated")
  }catch AgentBridgeError.invalidConfiguration {print("preflight-blocked")}
  catch {print("refused")}
 }
}`);
  execFileSync('swiftc',['-parse-as-library',join(dir,'TLS.swift'),'-o',join(dir,'tls')],{timeout:60000});
  const requests=[];
  server=createServer({key:readFileSync(join(dir,'leaf.key')),cert},(req,res)=>{
   requests.push({path:req.url,authorization:req.headers.authorization});
   res.setHeader('content-type','application/json');res.end(JSON.stringify({eventProtocol:1,ready:true,userId:'synthetic-user'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='https://127.0.0.1:'+server.address().port;
  assert.match((await execAsync(join(dir,'tls'),[url,pin],{timeout:20000})).stdout,/authenticated/);
  assert.deepEqual(requests,[{path:'/connection/status',authorization:'Bearer synthetic-token-only'}]);
  assert.match((await execAsync(join(dir,'tls'),[url,'C'.repeat(64)],{timeout:20000})).stdout,/refused/);
  assert.equal(requests.length,1,'a mismatched leaf must receive zero application bytes/token');
  assert.match((await execAsync(join(dir,'tls'),[url,pin,'public-target'],{timeout:20000})).stdout,/preflight-blocked/);
  assert.equal(requests.length,1,'changing a local paired bearer to PKI must be blocked before any request');
 } finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  rmSync(dir,{recursive:true,force:true});
 }
});
