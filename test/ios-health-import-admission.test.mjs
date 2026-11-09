import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const swiftSource=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
const hasSwift=spawnSync('swift',['--version'],{encoding:'utf8'}).status===0;

// 从真实发布的 Swift 源码里取出这段准入判断，编译后跑一遍：
// 断言的是 App 里真正在跑的那份逻辑，不是照抄一份。
function compileAdmission() {
  const start=swiftSource.indexOf('enum HealthImportAdmission {');
  assert.notEqual(start,-1,'找不到健康导入的准入判断');
  const end=swiftSource.indexOf('\n}',start);
  assert.ok(end>start,'健康导入的准入判断没有闭合');
  const dir=mkdtempSync(join(tmpdir(),'along-swift-'));
  const file=join(dir,'admission.swift');
  writeFileSync(file,`${swiftSource.slice(start,end+2)}
let admitted = HealthImportAdmission.refusal(pending: nil)
let refused = HealthImportAdmission.refusal(pending: "id-1")
print(admitted == nil ? "admit" : "wrongly-refused")
if let refusal = refused {
  print("error:\\(refusal["error"] as? String ?? "missing")")
  print("ok:\\(refusal["ok"] as? Bool ?? true)")
} else {
  print("missing-refusal")
}
`);
  try { return execFileSync('swift',[file],{encoding:'utf8'}); }
  finally { rmSync(dir,{recursive:true,force:true}); }
}

test('the iOS bridge answers a second health import instead of dropping it',{skip:hasSwift?false:'本机没有 Swift 工具链，跳过原生侧行为测试'},()=>{
  const output=compileAdmission();
  assert.match(output,/^admit$/m,'没有在途导入时必须放行');
  assert.match(output,/^error:已有健康数据导入正在进行$/m,'后来的请求要拿到明确的答复');
  assert.match(output,/^ok:false$/m,'答复必须是失败结果，网页那边的 Promise 才会落定');
});

test('the refused import is delivered to the web view, not silently returned',()=>{
  const start=swiftSource.indexOf('func begin(id: String');
  const end=swiftSource.indexOf('func readPreview()');
  const begin=swiftSource.slice(start,end);
  assert.doesNotMatch(begin,/guard requestID == nil else \{ return \}/,'不能悄悄丢掉后来的请求：网页那边的 Promise 会永远悬着');
  assert.match(begin,/HealthImportAdmission\.refusal/);
  assert.match(begin,/deliver\(id: id, result: refusal, to: webView\)/,'被拒绝的请求必须答复给网页');
});
