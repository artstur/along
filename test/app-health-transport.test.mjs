import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const agentKey='along.agent.v1',eventKey='along.event-connection.v1',workspaceKey='along.event-workspace.v1:u_12345678';
const local={baseURL:'https://192.168.10.2:4176',token:'b'.repeat(64),fingerprint:'A'.repeat(64)};
const event={userId:'u_12345678',fingerprint:local.fingerprint};
const cache={userId:event.userId,cursor:17,drafts:{new:'原合成草稿'},pendingAck:[17]};

test('the iPhone upgrade stops using a cached Mac connection and leaves its workspace in storage',async()=>{
  const storage={[agentKey]:JSON.stringify(local),[eventKey]:JSON.stringify(event),[workspaceKey]:JSON.stringify(cache)};
  const dom=installDomStub({storage});
  location.protocol='along:';
  document.visibilityState='visible';
  const calls=[];
  window.AlongAgentBridge={
    connection:async (action,value)=>{calls.push([action,value]);return {};},
    request:async input=>{calls.push(input);throw Error('unexpected legacy request');},
  };
  await import('../web/app.mjs?retired-lan-connection');
  await dom.click({action:'open-settings'});
  await dom.tick(3000);

  assert.match(dom.app.innerHTML,/未配对/);
  const form=dom.app.innerHTML.match(/<form id="pair-form">.*?<\/form>/s)?.[0];
  assert.ok(form);
  assert.deepEqual([...form.matchAll(/<input name="([^"]+)"/g)].map(match=>match[1]),['baseURL','code']);
  assert.doesNotMatch(dom.app.innerHTML,/192\.168\.10\.2|只更新服务地址|重试连接/);
  assert.deepEqual(calls,[['load',undefined]]);
  for (const [key,value] of Object.entries(storage)) assert.equal(dom.storage.get(key),value);
});
