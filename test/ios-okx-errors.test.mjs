import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';

test('the real OKX catch shows trusted failure reasons and never arbitrary server or NSError text',{skip:process.platform!=='darwin'},()=>{
  const source=readFileSync(new URL('../ios/AlongHealth/Sources/OkxConnection.swift',import.meta.url),'utf8');
  const shell=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
  const policy=source.slice(source.indexOf('private enum OKXConnectionAction'),source.indexOf('private struct OKXConnectionSnapshot'));
  const errorType=shell.slice(shell.indexOf('enum AgentBridgeError:'),shell.indexOf('// 云端 DNS 与公网 IPv4 的系统信任评估委托'));
  const catchAssignment=source.split('// Never surface')[1]?.match(/errorMessage = (action\.failureMessage[^}\n]*)/)?.[0]?.trim();
  assert.ok(catchAssignment,'exercise the assignment from the actual catch block');
  const dir=mkdtempSync(join(tmpdir(),'along-okx-errors-'));
  try {
    writeFileSync(join(dir,'main.swift'),`import Foundation\nimport CFNetwork\n${errorType}\n${policy}\n`+`
private func message(_ error: Error, _ action: OKXConnectionAction = .connect) -> String {
    var errorMessage: String?
    ${catchAssignment}
    return errorMessage ?? ""
}
func check(_ value: Bool, _ explanation: String) { if !value { fatalError(explanation) } }
check(message(AgentBridgeError.server("OKX 请求超时，请稍后重试。")).contains("Along 服务请求 OKX 超时"), "host timeout must not become a credentials failure")
check(message(AgentBridgeError.server("暂时无法连接 OKX，请稍后重试。")).contains("Along 服务暂时无法连接 OKX"), "host network error needs its own reason")
check(message(AgentBridgeError.server("仅支持只读 API Key，请关闭交易和提现权限后重试。")).contains("仅支持只读"), "permission rejection must remain visible")
check(message(AgentBridgeError.server("OKX 未接受请求，请检查凭证、所属站点及 IP 白名单。")).contains("IP 白名单"), "API rejection needs useful fixed guidance")
check(message(URLError(.cannotConnectToHost)).contains("iPhone 无法连接 Along 服务"), "phone transport must not be called an OKX failure")
check(message(AgentBridgeError.server("OKX 请求超时，请稍后重试。"), .refresh).contains("上次同步"), "refresh failure must identify stale data")
check(message(AgentBridgeError.server("remote-secret")) == OKXConnectionAction.connect.failureMessage, "unknown remote strings must not leak")
check(message(NSError(domain: "untrusted", code: 1, userInfo: [NSLocalizedDescriptionKey:"remote-secret"])) == OKXConnectionAction.connect.failureMessage, "NSError descriptions must not leak")
check(!message(AgentBridgeError.server("OKX 请求超时，请稍后重试。remote-secret")).contains("remote-secret"), "whitelist must use exact matches")
print("native OKX failure reasons passed")
`);
    execFileSync('xcrun',['swiftc','-module-cache-path',join(dir,'cache'),join(dir,'main.swift'),'-o',join(dir,'check')],{timeout:60000,maxBuffer:2_000_000});
    assert.match(execFileSync(join(dir,'check'),{encoding:'utf8',timeout:10000}),/native OKX failure reasons passed/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
