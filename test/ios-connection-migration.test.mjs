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
function compileMigration() {
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
  source=source.replaceAll('UserDefaults.standard','FakeDefaults.shared');

  const dir=mkdtempSync(join(tmpdir(),'along-swift-'));
  const file=join(dir,'migration.swift');
  writeFileSync(file,`import Foundation
import Security

final class FakeDefaults {
    static let shared = FakeDefaults()
    var storage: [String: Any] = [:]
    func dictionary(forKey key: String) -> [String: Any]? { storage[key] as? [String: Any] }
    func removeObject(forKey key: String) { storage.removeValue(forKey: key) }
}
var keychainWriteFails = false

${source}
let legacy: [String: Any] = ["baseURL":"https://192.168.1.2:4176","fingerprint":"${'A'.repeat(64)}","token":"${'b'.repeat(64)}"]

FakeDefaults.shared.storage["along.connection.v1"] = legacy
keychainWriteFails = true
_ = AlongConnectionStore.load()
print("write-failed-kept:\\(FakeDefaults.shared.storage["along.connection.v1"] != nil)")

FakeDefaults.shared.storage["along.connection.v1"] = legacy
keychainWriteFails = false
_ = AlongConnectionStore.load()
print("write-ok-removed:\\(FakeDefaults.shared.storage["along.connection.v1"] == nil)")
`);
  try { return execFileSync('swift',[file],{encoding:'utf8'}); }
  finally { rmSync(dir,{recursive:true,force:true}); }
}

test('the old connection is only dropped after it is safely stored in the keychain',{skip:hasSwift?false:'本机没有 Swift 工具链，跳过原生侧行为测试'},()=>{
  const output=compileMigration();
  assert.match(output,/^write-failed-kept:true$/m,'钥匙串写失败时不能删掉唯一一份凭证');
  assert.match(output,/^write-ok-removed:true$/m,'迁移成功后旧键要清掉');
});
