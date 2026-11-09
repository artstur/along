import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installDomStub} from './dom-stub.mjs';

async function withoutCrypto(value,run) {
  const original=globalThis.crypto;
  Object.defineProperty(globalThis,'crypto',{value,configurable:true});
  try { await run(); }
  finally { Object.defineProperty(globalThis,'crypto',{value:original,configurable:true}); }
}

test('the app still works when crypto.randomUUID is missing, as in a non-secure context',async()=>{
  const dom=installDomStub({});
  await withoutCrypto({},async()=>{
    await import('../web/app.mjs');
    await dom.click({action:'new-goal'});
    assert.match(dom.app.innerHTML,/定义我的新目标/,'没有 crypto.randomUUID 也不能建不了新目标');
    await dom.submit();
    assert.match(dom.app.innerHTML,/agent-page/,'没有 crypto.randomUUID 也不能发不出消息');
  });
});

test('the app still works when the crypto object itself is missing',async()=>{
  const dom=installDomStub({});
  await withoutCrypto(undefined,async()=>{
    await import('../web/app.mjs?no-crypto');
    await dom.click({action:'new-goal'});
    assert.match(dom.app.innerHTML,/定义我的新目标/);
  });
});

test('the injected iOS bridge script does not touch a bare crypto identifier',()=>{
  const source=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
  assert.doesNotMatch(source,/[^.\w]crypto\?\.randomUUID/,'crypto 整个不存在时可选链也救不了，必须走 globalThis');
});
