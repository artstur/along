import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

test('the app still works when crypto.randomUUID is missing, as in a non-secure context',async()=>{
  const dom=installDomStub({});
  const original=globalThis.crypto;
  Object.defineProperty(globalThis,'crypto',{value:{},configurable:true});
  try {
    await import('../web/app.mjs');
    await dom.click({action:'new-goal'});
    assert.match(dom.app.innerHTML,/定义我的新目标/,'没有 crypto.randomUUID 也不能建不了新目标');
    await dom.submit();
    assert.match(dom.app.innerHTML,/agent-page/,'没有 crypto.randomUUID 也不能发不出消息');
  } finally {
    Object.defineProperty(globalThis,'crypto',{value:original,configurable:true});
  }
});
