import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const swiftSource=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
const hasSwift=spawnSync('swift',['--version'],{encoding:'utf8'}).status===0;

// 从真实发布的 Swift 源码里取出连接存储这一段，编译后跑一遍：
// 断言的是 App 里真正在跑的那份逻辑，不是照抄一份。
// 只有两个边界用替身：钥匙串写入（save）与 UserDefaults。
function storeSnippet() {
  const start=swiftSource.indexOf('enum AlongConnectionStore {');
  assert.notEqual(start,-1,'找不到连接存储');
  const end=swiftSource.indexOf('\n}\n',start);
  assert.ok(end>start,'连接存储没有闭合');
  let source=swiftSource.slice(start,end+3);

  // 替身一：钥匙串写入可以失败。
  const saveStart=source.indexOf('    @discardableResult\n    static func save(');
  const saveEnd=source.indexOf('        return clean\n    }',saveStart);
  assert.ok(saveStart>0&&saveEnd>saveStart,'找不到钥匙串写入');
  source=source.slice(0,saveStart)+`    @discardableResult
    static func save(_ value: [String: Any]) -> [String: String]? {
        if keychainWriteFails { return nil }
        return clean(value)
    }
`+source.slice(saveEnd+'        return clean\n    }'.length);

  // 替身二：UserDefaults。
  return source.replaceAll('UserDefaults.standard','FakeDefaults.shared');
}

const storeHarness=`import Foundation
import Security
import CryptoKit

final class FakeDefaults {
    static let shared = FakeDefaults()
    var storage: [String: Any] = [:]
    func dictionary(forKey key: String) -> [String: Any]? { storage[key] as? [String: Any] }
    func removeObject(forKey key: String) { storage.removeValue(forKey: key) }
}
var keychainWriteFails = false
`;

function compileStore(main) {
  const dir=mkdtempSync(join(tmpdir(),'along-swift-'));
  const file=join(dir,'migration.swift');
  writeFileSync(file,`${storeHarness}

${storeSnippet()}
${main}
`);
  try { return execFileSync('swift',[file],{encoding:'utf8'}); }
  finally { rmSync(dir,{recursive:true,force:true}); }
}

function compileMigration() {
  return compileStore(`let legacy: [String: Any] = ["baseURL":"https://along.example.com:4176","fingerprint":"${'A'.repeat(64)}","token":"${'b'.repeat(64)}"]

FakeDefaults.shared.storage["along.connection.v1"] = legacy
keychainWriteFails = true
_ = AlongConnectionStore.load()
print("write-failed-kept:\\(FakeDefaults.shared.storage["along.connection.v1"] != nil)")

FakeDefaults.shared.storage["along.connection.v1"] = legacy
keychainWriteFails = false
_ = AlongConnectionStore.load()
print("write-ok-removed:\\(FakeDefaults.shared.storage["along.connection.v1"] == nil)")
`);
}

test('the old connection is only dropped after it is safely stored in the keychain',{skip:hasSwift?false:'本机没有 Swift 工具链，跳过原生侧行为测试'},()=>{
  const output=compileMigration();
  assert.match(output,/^write-failed-kept:true$/m,'钥匙串写失败时不能删掉唯一一份凭证');
  assert.match(output,/^write-ok-removed:true$/m,'迁移成功后旧键要清掉');
});

// M6（docs/cloud-deploy-multi-user.md §4/§5.6）：连接地址在 RFC1918 私网 IPv4 之外放行合法 DNS 域名，
// https-only 与其余校验不变。两份守卫（clean/agentRequest）都编译真实源码后断言。
test('only cloud pairings can be loaded or saved',{skip:hasSwift?false:'本机没有 Swift 工具链，跳过原生侧行为测试'},()=>{
  const output=compileStore(`extension AlongConnectionStore {
    static func exposeClean(_ value: [String: Any]) -> [String: String]? { clean(value) }
}

let fingerprint = "${'A'.repeat(64)}"
let token = "${'b'.repeat(64)}"
let cases: [(String, Bool)] = [
    ("https://192.168.1.2:4176", false),
    ("https://10.0.0.5:4176", false),
    ("https://172.16.0.9:4176", false),
    ("https://172.31.255.255:4176", false),
    ("https://172.32.0.1:4176", true),
    ("https://8.8.8.8:4176", true),
    ("https://0.1.2.3:4176", false),
    ("https://8.008.8.8:4176", false),
    ("https://127.0.0.1:4176", false),
    ("https://100.64.0.1:4176", false),
    ("https://169.254.0.1:4176", false),
    ("https://192.0.2.1:4176", false),
    ("https://198.18.0.1:4176", false),
    ("https://198.51.100.1:4176", false),
    ("https://203.0.113.1:4176", false),
    ("https://224.1.2.3:4176", false),
    ("https://240.1.2.3:4176", false),
    ("https://0x7f.0x1:4176", false),
    ("https://1.2.3.4.5:4176", false),
    ("https://[::1]:4176", false),
    ("https://along.example.com:4176", true),
    ("http://along.example.com:4176", false),
    ("https://user:pass@along.example.com:4176", false),
    ("https://along.example.com/pair", false),
    ("https://along.example.com:4176/?x=1", false),
    ("https://along.example.com:4176#frag", false),
    ("https://along..example.com:4176", false),
    ("https://.example.com:4176", false),
    ("https://along.example.com.:4176", false),
    ("https://-along.example.com:4176", false),
    ("https://along.example.com-:4176", false),
    ("https://al_ong.example.com:4176", false),
    ("https://macbook:4176", false),
]
for (baseURL, expected) in cases {
    let accepted = AlongConnectionStore.exposeClean(["baseURL": baseURL, "fingerprint": fingerprint, "token": token]) != nil
    let verdict = accepted == expected ? "ok" : "FAIL"
    print("\\(verdict) \\(baseURL)")
}
`);
  assert.doesNotMatch(output,/FAIL/,'主机校验结果与预期不符');
  assert.match(output,/^ok https:\/\/along\.example\.com:4176$/m,'合法 DNS 域名要放行');
  assert.match(output,/^ok https:\/\/192\.168\.1\.2:4176$/m,'局域网地址应被拒绝');
});

test('the agent request gate admits cloud addresses and rejects private endpoints',{skip:hasSwift?false:'本机没有 Swift 工具链，跳过原生侧行为测试'},()=>{
  const funcStart=swiftSource.indexOf('        static func agentRequest(');
  assert.notEqual(funcStart,-1,'找不到 agentRequest');
  const guardStart=swiftSource.indexOf('            guard let base = input["baseURL"]',funcStart);
  const throwMark='else { throw AgentBridgeError.invalidConfiguration }';
  const guardEnd=swiftSource.indexOf(throwMark,guardStart);
  assert.ok(guardStart>funcStart&&guardEnd>guardStart,'找不到 agentRequest 的入口守卫');
  const guardSource=swiftSource.slice(guardStart,guardEnd)+'else { return false }';
  const dir=mkdtempSync(join(tmpdir(),'along-gate-'));
  try {
    const file=join(dir,'gate.swift');
    writeFileSync(file,`${storeHarness}

${storeSnippet()}

func probe(_ input: [String: Any], privateNotificationRequest: Bool = false, privateSourceRequest: Bool = false) -> Bool {
    ${guardSource}
    return true
}

let fingerprint = "${'A'.repeat(64)}"
let token = "${'b'.repeat(64)}"
let cases: [(String, String, Bool)] = [
    ("https://192.168.1.2:4176", "/goal/event", false),
    ("https://10.0.0.2:4176", "/pair", false),
    ("https://172.16.0.2:4176", "/events", false),
    ("https://macbook.Local:4176", "/pair", false),
    ("https://foo.localhost:4176", "/pair", false),
    ("https://home.arpa:4176", "/pair", false),
    ("https://mac.home.arpa:4176", "/pair", false),
    ("https://along.example.com:4176", "/goal/event", true),
    ("https://along.example.com:4176", "/connection/verify", false),
    ("http://along.example.com:4176", "/goal/event", false),
    ("https://user:pass@along.example.com:4176", "/goal/event", false),
    ("https://along.example.com/pair", "/goal/event", false),
    ("https://172.32.0.1:4176", "/goal/event", true),
    ("https://8.8.8.8:4176", "/goal/event", true),
    ("https://along..example.com:4176", "/goal/event", false),
    ("https://along.example.com:4176", "/not/whitelisted", false),
    ("https://along.example.com:4176", "/notifications/device", false),
    ("https://along.example.com:4176", "/workspace-handoff/status", false),
]
for (baseURL, path, expected) in cases {
    let verdict = probe(["baseURL": baseURL, "fingerprint": fingerprint, "token": token, "path": path, "body": [:] as [String: Any]]) == expected ? "ok" : "FAIL"
    print("\\(verdict) \\(baseURL) \\(path)")
}
let privateRequest: [String: Any] = ["baseURL": "https://along.example.com:4176", "fingerprint": fingerprint, "token": token, "path": "/notifications/device", "body": [:] as [String: Any]]
print(probe(privateRequest, privateNotificationRequest: true) ? "ok private-flag-passes" : "FAIL private-flag-passes")
print(probe(["baseURL": "https://along.example.com:4176", "fingerprint": fingerprint, "token": token, "path": "/sources/okx", "body": [:] as [String: Any]], privateSourceRequest: true) ? "ok source-flag-passes" : "FAIL source-flag-passes")
`);
    const output=execFileSync('swift',[file],{encoding:'utf8'});
    assert.doesNotMatch(output,/FAIL/,'请求守卫结果与预期不符');
    assert.match(output,/^ok https:\/\/along\.example\.com:4176 \/goal\/event$/m,'域名要走通 agentRequest 守卫');
    assert.match(output,/^ok https:\/\/192\.168\.1\.2:4176 \/goal\/event$/m,'原生应拒绝旧局域网连接');
    assert.match(output,/^ok https:\/\/along\.example\.com:4176 \/notifications\/device$/m,'私有端点仍要求对应开关');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('the iPhone explains proxy failures and unreachable cloud service',{skip:!hasSwift||process.platform!=='darwin'},()=>{
  const start=swiftSource.indexOf('enum AgentBridgeError:');
  const end=swiftSource.indexOf('\n}',start)+2;
  const dir=mkdtempSync(join(tmpdir(),'along-transport-'));
  try {
    const file=join(dir,'check.swift');
    writeFileSync(file,`import Foundation
import CFNetwork
${swiftSource.slice(start,end)}
let proxy = NSError(domain: kCFErrorDomainCFNetwork as String, code: 310)
let wrapped = NSError(domain: NSURLErrorDomain, code: -1004, userInfo: [NSUnderlyingErrorKey: proxy])
let cases: [Error] = [proxy, wrapped, NSError(domain: NSURLErrorDomain, code: 310),
    URLError(.timedOut), URLError(.cannotConnectToHost), URLError(.notConnectedToInternet),
    NSError(domain: "Unrelated", code: 310), URLError(.cancelled)]
for error in cases { print(AgentBridgeError.transportMessage(error) ?? "unchanged") }
`);
    const output=execFileSync('swift',['-module-cache-path',join(dir,'cache'),file],{encoding:'utf8'}).trim().split('\n');
    for (const message of output.slice(0,3)) assert.match(message,/代理.*Along 服务/);
    for (const message of output.slice(3,6)) assert.match(message,/Along 服务.*服务地址/);
    assert.deepEqual(output.slice(6),['unchanged','unchanged']);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

// 配对测试（docs/cloud-deploy-multi-user.md §5.6 / §4 M6）：实现者之外的第二份独立断言。
// 用例全部从文档验收标准推导，不照抄实现者清单；URLComponents.host 的形态先经 Swift 探针实测
// （大写保留原样、IDN 原文原样、punycode 会被解回 Unicode、IPv6 带方括号）。
test('the paired host accepts the documented domain form and its boundaries, not numeric IP look-alikes',{skip:hasSwift?false:'本机没有 Swift 工具链，跳过原生侧行为测试'},()=>{
  const l63='a'.repeat(63);
  // 4 段全字母标签：63+1+63+1+63+1+61=253（边界内）、62 收尾即 254（超限）。
  const host253=`${l63}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  const host254=`${l63}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
  const l64='a'.repeat(64);
  const output=compileStore(`extension AlongConnectionStore {
    static func exposeClean(_ value: [String: Any]) -> [String: String]? { clean(value) }
}

let fingerprint = "${'A'.repeat(64)}"
let token = "${'b'.repeat(64)}"
let cases: [(String, Bool)] = [
    ("https://along.example.com", true),          // 文档验收原例：无端口域名
    ("https://ALONG.EXAMPLE.COM:4176", true),     // 字符集含大写（DNS 大小写不敏感）
    ("https://a.b:4176", true),                   // 每段 1–63 字符 → 单字符标签合法
    ("https://${l63}.com:4176", true),            // 标签长度上限 63
    ("https://${l64}.com:4176", false),           // 标签 64 超限
    ("https://${host253}:4176", true),            // 主机总长 253 在边界内
    ("https://${host254}:4176", false),           // 主机总长 254 超限
    ("https://123.com:4176", true),               // 数字段+字母末段：按文档字符集是合法域名，不是 IP
    ("https://along.example.com:4176/", false),   // path "/" 也算带 path，拒绝
    ("https://例子.com:4176", false),             // 非 ASCII 的 IDN 原文，不在文档字符集内
    ("https://xn--fiq228c.com:4176", false),      // URLComponents.host 把 punycode 解回 Unicode，同样被拒
    ("https://0x7f.0.0.1:4176", false),           // 十六进制 IP 形态：非私网数字 IP，拒绝
    ("https://2130706433:4176", false),           // 整数 IP 形态：单段，拒绝
    ("https://192.168.1.2:4176", false),           // 局域网地址应被拒绝
    ("https://172.16.0.9:4176", false),
    ("https://8.8.8.8:4176", true),
]
for (baseURL, expected) in cases {
    let accepted = AlongConnectionStore.exposeClean(["baseURL": baseURL, "fingerprint": fingerprint, "token": token]) != nil
    print("\\(accepted == expected ? "ok" : "FAIL") \\(baseURL)")
}
`);
  assert.doesNotMatch(output,/FAIL/,'clean() 的域名边界结果与文档预期不符');
  assert.match(output,/^ok https:\/\/along\.example\.com$/m,'文档验收原例（无端口域名）要放行');
  assert.match(output,/^ok https:\/\/192\.168\.1\.2:4176$/m,'局域网地址应被拒绝');
});

test('the agent gate keeps credential, path and endpoint rules when the host is a domain',{skip:hasSwift?false:'本机没有 Swift 工具链，跳过原生侧行为测试'},()=>{
  const funcStart=swiftSource.indexOf('        static func agentRequest(');
  assert.notEqual(funcStart,-1,'找不到 agentRequest');
  const guardStart=swiftSource.indexOf('            guard let base = input["baseURL"]',funcStart);
  const throwMark='else { throw AgentBridgeError.invalidConfiguration }';
  const guardEnd=swiftSource.indexOf(throwMark,guardStart);
  assert.ok(guardStart>funcStart&&guardEnd>guardStart,'找不到 agentRequest 的入口守卫');
  const gateSource=swiftSource.slice(guardStart,guardEnd)+'else { return false }';
  const dir=mkdtempSync(join(tmpdir(),'along-gate-paired-'));
  try {
    const file=join(dir,'gate-paired.swift');
    writeFileSync(file,`${storeHarness}

${storeSnippet()}

func probe(_ input: [String: Any], privateNotificationRequest: Bool = false, privateSourceRequest: Bool = false) -> Bool {
    ${gateSource}
    return true
}

let good = "${'A'.repeat(64)}"
let tok = "${'b'.repeat(64)}"
// (baseURL, path, fingerprint, token, expected)
let cases: [(String, String, String, String, Bool)] = [
    ("https://along.example.com", "/goal/event", good, tok, true),   // 无端口域名走通文档验收例
    ("https://along.example.com", "/pair", good, tok, true),         // 多用户配对复用 /pair，域名下必须可达
    ("https://192.168.1.2", "/goal/event", good, tok, false),
    // 云端证书由系统信任评估。入口无视旧版页面传来的叶指纹。
    ("https://along.example.com:4176", "/goal/event", String(repeating:"F",count:63), tok, true),
    ("https://192.168.1.2:4176", "/goal/event", String(repeating:"F",count:63), tok, false),
    // token 的 64hex 校验在连接存储时（clean()，:458-459）；agentRequest 入口守卫从不校验 token，
    // 只在 :977 读取后放进 Bearer 头——这是 M6 之前就有的行为（已对 HEAD 核实），文档 §3.4「指纹与
    // token 仍须 64hex」的行号引用容易误读成入口也校验 token，此处按真实既有语义断言。
    ("https://along.example.com:4176", "/goal/event", good, String(repeating:"f",count:63), true),
    ("https://along.example.com:4176/", "/goal/event", good, tok, false), // path "/" 在入口守卫拒绝
    ("https://8.8.8.8", "/pair", "", "", true),
    ("https://8.8.8.8", "/connection/verify", "", tok, false),
    ("https://8.8.8.8", "/sync", "", tok, true),
    ("https://8.8.8.8", "/sync/ack", "", tok, true),
    ("https://8.8.8.8", "/events", "", tok, true),
    ("https://100.64.0.1", "/sync", good, tok, false),
    ("http://8.8.8.8", "/sync", "", tok, false),
]
for (baseURL, path, fp, tk, expected) in cases {
    let ok = probe(["baseURL": baseURL, "fingerprint": fp, "token": tk, "path": path, "body": [:] as [String: Any]]) == expected
    print("\\(ok ? "ok" : "FAIL") \\(baseURL) \\(path)")
}
`);
    const output=execFileSync('swift',[file],{encoding:'utf8'});
    assert.doesNotMatch(output,/FAIL/,'agentRequest 入口守卫结果与文档预期不符');
    assert.match(output,/^ok https:\/\/along\.example\.com \/goal\/event$/m,'无端口域名要走通入口守卫');
    assert.match(output,/^ok https:\/\/along\.example\.com \/pair$/m,'配对端点在域名下仍可达');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('public IP uses system trust and preserves the Keychain scope across leaf rotation',{skip:!hasSwift},()=>{
  const output=compileStore(`
let token = "${'b'.repeat(64)}"
let first = AlongConnectionStore.save(["baseURL":"https://8.8.8.8","token":token,"fingerprint":"${'A'.repeat(64)}","trustPolicy":"legacy-local-pin-v1"])
let next = AlongConnectionStore.save(["baseURL":"https://8.8.8.8:443","token":token,"fingerprint":"${'C'.repeat(64)}"])
let local = AlongConnectionStore.save(["baseURL":"https://192.168.1.2","token":token,"fingerprint":"${'A'.repeat(64)}","trustPolicy":AlongConnectionStore.systemTrustPolicy])
print(first?["trustPolicy"] == AlongConnectionStore.systemTrustPolicy && first?["fingerprint"] == nil)
print(first.flatMap(AlongConnectionStore.scopeSeed) != nil && first.flatMap(AlongConnectionStore.scopeSeed) == next.flatMap(AlongConnectionStore.scopeSeed))
print(local == nil)
`);
  assert.deepEqual(output.trim().split('\n'),['true','true','true']);
});

test('native rebuild linkage: bundled page cache marker and bundle version both moved',()=>{
  // SD-5 / AGENTS.md §2：iOS 原生改动 → AlongShellView.swift 的 build= 与 Info.plist 的 CFBundleVersion 必动。
  const webEntry=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const cacheVersion=webEntry.match(/app\.mjs\?v=(\d+)/)?.[1];
  assert.ok(Number(cacheVersion)>=83,'云端运行恢复需要新页面缓存');
  assert.match(swiftSource,new RegExp(`index\\.html\\?build=${cacheVersion}\\b`),'App 内置页面标记必须与 Web 同步');
  const plist=readFileSync(new URL('../ios/AlongHealth/Info.plist',import.meta.url),'utf8');
  assert.ok(Number(plist.match(/<key>CFBundleVersion<\/key>\s*<string>(\d+)<\/string>/)?.[1])>=74,'发版重装信号 CFBundleVersion 必须提高');
  const pbxproj=readFileSync(new URL('../ios/AlongHealth.xcodeproj/project.pbxproj',import.meta.url),'utf8');
  assert.doesNotMatch(pbxproj,/CURRENT_PROJECT_VERSION/,'pbxproj 不得出现 CURRENT_PROJECT_VERSION 覆盖 Info.plist 的 CFBundleVersion');
});

test('Keychain connection preserves the cloud DSH hint and ignores unknown runtime values',{skip:!hasSwift},()=>{
  const output=compileStore(`
let connection = ["baseURL": "https://along.example.com",
                  "fingerprint": String(repeating: "A", count: 64),
                  "token": String(repeating: "b", count: 64),
                  "runtime": "dsh-superagent"]
print(AlongConnectionStore.save(connection)?["runtime"] ?? "missing")
var unknown = connection
unknown["runtime"] = "other-runtime"
print(AlongConnectionStore.save(unknown)?["runtime"] ?? "missing")
`);
  assert.equal(output.trim(),'dsh-superagent\nmissing');
});

test('ordinary endpoint whitelist includes pairing, sync, notifications and device sources',()=>{
  const funcStart=swiftSource.indexOf('        static func agentRequest(');
  assert.notEqual(funcStart,-1,'找不到 agentRequest');
  const condStart=swiftSource.indexOf('(["/pair"',funcStart);
  assert.notEqual(condStart,-1,'找不到路径白名单');
  const condEnd=swiftSource.indexOf('.contains(path)))',condStart);
  assert.ok(condEnd>condStart,'路径白名单没有闭合');
  const condition=swiftSource.slice(condStart,condEnd+'.contains(path)))'.length);
  const groups=[...condition.matchAll(/\[([^\[\]]*)\]\.contains\(path\)/g)]
    .map(m=>m[1].split(',').map(s=>s.trim().replaceAll('"','')));
  assert.equal(groups.length,3);
  assert.deepEqual(groups[0],
    ['/pair','/connection/status','/goal/event','/super-agent/tasks','/super-agent/tasks/status','/super-agent/daily-delegation','/super-agent/goals','/super-agent/goals/status','/events','/sync','/sync/ack'],
    '主路径 11 条（/pair 是配对的唯一入口）');
  assert.deepEqual(groups[1],['/notifications/device','/notifications/scheduled'],'通知端点零新增');
  assert.deepEqual(groups[2],['/sources/okx','/sources/device'],'设备来源端点零新增');
});

test('every agent request uses system trust, redirect blocking and the existing DIRECT policy',()=>{
  const funcStart=swiftSource.indexOf('        static func agentRequest(');
  assert.ok(funcStart>=0);
  const body=swiftSource.slice(funcStart,swiftSource.indexOf('        func webView(',funcStart));
  assert.match(body,/let delegate = SystemTrustAgentDelegate\(expectedHost: host\)/);
  assert.match(body,/URLSession\(configuration: configuration, delegate: delegate/);
  assert.match(body,/connectionProxyDictionary[\s\S]*?return 'DIRECT'/);
  assert.doesNotMatch(swiftSource,/PinnedAgentDelegate|ALONG_MIGRATE_URL|checkLocalRoute/);
  const plist=readFileSync(new URL('../ios/AlongHealth/Info.plist',import.meta.url),'utf8');
  assert.doesNotMatch(plist,/NSLocalNetworkUsageDescription/);
  const systemStart=swiftSource.indexOf('final class SystemTrustAgentDelegate');
  assert.notEqual(systemStart,-1,'找不到 SystemTrustAgentDelegate');
  const systemEnd=swiftSource.indexOf('\n}\n',systemStart);
  const system=swiftSource.slice(systemStart,systemEnd);
  assert.match(system,/completionHandler\(\.performDefaultHandling, nil\)/,'云端走系统默认信任评估，不自行放行');
  assert.doesNotMatch(system,/useCredential/,'云端不得自行返回 useCredential');
  assert.doesNotMatch(system,/SecTrustSetAnchorCertificates/,'云端不得塞入自己的信任锚');
  assert.match(system,/guard host == expectedHost/,'挑战主机必须与当前连接的期望主机一致');
  assert.match(system,/willPerformHTTPRedirection[\s\S]*?completionHandler\(nil\)/,'重定向仍被丢弃');
});

test('iPhone foreground requests retain their deadlines and background work stops promptly offline',{skip:!hasSwift},()=>{
  assert.match(swiftSource,/configuration\.waitsForConnectivity = !background/);
  const request=swiftSource.match(/request\.timeoutInterval = ([^\n]+)/)?.[1];
  const resource=swiftSource.match(/configuration\.timeoutIntervalForResource = ([^\n]+)/)?.[1];
  assert.ok(request&&resource);
  const dir=mkdtempSync(join(tmpdir(),'along-deadlines-'));
  try {
    const file=join(dir,'main.swift');
    writeFileSync(file,`import Foundation\nfunc deadline(_ background: Bool,_ path: String) -> [Double] { [${request},${resource}] }\nlet values=[deadline(false,"/events"),deadline(false,"/connection/status"),deadline(false,"/sources/device"),deadline(true,"/events"),deadline(true,"/sources/device")]\nprint(String(data:try! JSONSerialization.data(withJSONObject:values),encoding:.utf8)!)`);
    const output=execFileSync('swift',['-module-cache-path',join(dir,'cache'),file],{encoding:'utf8',timeout:30000});
    assert.deepEqual(JSON.parse(output),[[120,120],[120,120],[12,15],[8,10],[8,10]]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
