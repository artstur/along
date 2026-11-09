import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

test('the app registers the offline shell when the browser supports it',async()=>{
  const dom=installDomStub({});
  const registered=[];
  Object.defineProperty(globalThis.navigator,'serviceWorker',{value:{register:url=>{registered.push(url);return Promise.resolve();}},configurable:true});
  try {
    await import('../web/app.mjs?sw-register');
    assert.deepEqual(registered,['./sw.js'],'浏览器支持时要把离线壳注册上');
  } finally { delete globalThis.navigator.serviceWorker; }
});

test('the app still works where service workers are unavailable',async()=>{
  const dom=installDomStub({});
  await import('../web/app.mjs?no-service-worker');
  assert.match(dom.app.innerHTML,/goal-card/,'不支持 Service Worker 的环境照常能用');
});
