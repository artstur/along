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

test('actual native agentRequest rejects LAN endpoints, cross-origin bearers and untrusted cloud TLS before HTTP',{skip:!hasSwift},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'along-transport-tls-'));
 let server;
 try {
  makeTestCa(dir,'127.0.0.1');
  const cert=readFileSync(join(dir,'leaf.crt'));
  const pin=createHash('sha256').update(new X509Certificate(cert).raw).digest('hex').toUpperCase();
  const source=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
  const native=block(source,'        static func agentRequest(');
  const system=block(source,'final class SystemTrustAgentDelegate:');
  writeFileSync(join(dir,'TLS.swift'),`import Foundation
import CryptoKit
import Security
import CFNetwork
// The fixture uses loopback only to exercise system TLS evaluation. The
// production address admission check still runs for the LAN test below.
enum AlongConnectionStore {
 static let systemTrustPolicy="system-pki-v1"
 static func cloudHostAccepted(_ host:String)->Bool {
  (host=="127.0.0.1" && CommandLine.arguments.last != "lan") || productionCloudHostAccepted(host)
 }
 static let legacyKey="along.test.legacy"
 static func storedConnection()->[String:Any]? {
  switch CommandLine.arguments.last {
  case "retired-bearer": return ["baseURL":"https://192.168.10.2:4176","token":String(repeating:"b",count:64),"trustPolicy":"legacy-local-pin-v1"]
  case "cloud-bearer": return ["baseURL":"https://along.example.com","token":String(repeating:"b",count:64),"trustPolicy":systemTrustPolicy]
  default: return nil
  }
 }
 ${block(source,'    static func bindingScopeId(')}
 ${block(source,'    static func cloudHostAccepted(').replace('func cloudHostAccepted','func productionCloudHostAccepted')}
 ${block(source,'    static func permitsPairedTransport(')}
 ${block(source,'    static func clean(')}
}
enum AgentBridgeError:Error {
 case invalidConfiguration,invalidResponse,receipt([String:Any]),server(String),httpStatus(Int,String)
 static func transportMessage(_ error:Error)->String? {nil}
}
${system}
enum Probe {
${native}
}
@main struct Fixture {
 static func main()async throws {
  let retiredPath=CommandLine.arguments.last=="retired-path"
  let input:[String:Any]=["baseURL":CommandLine.arguments[1],"fingerprint":CommandLine.arguments[2],"token":String(repeating:"b",count:64),"path":retiredPath ? "/workspace-handoff/status" : "/connection/status","body":retiredPath ? [:] : ["runtime":"dsh-superagent"]]
  do {
   _ = try await Probe.agentRequest(input,background:true)
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
  for (const mode of ['lan','retired-bearer','cloud-bearer','retired-path']) {
   assert.equal((await execAsync(join(dir,'tls'),[url,pin,mode],{timeout:20000})).stdout.trim(),'preflight-blocked');
  }
  assert.match((await execAsync(join(dir,'tls'),[url,pin,'cloud'],{timeout:20000})).stdout,/^refused$/m);
  assert.deepEqual(requests,[],'even the matching old leaf fingerprint must never release application bytes');

 } finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  rmSync(dir,{recursive:true,force:true});
 }
});
