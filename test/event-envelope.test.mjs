import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEnvelope, assembleEnvelope} from '../web/event-envelope.mjs';
import {queueEvent, pendingEvents} from '../web/agent-client.mjs';
import {installDomStub} from './dom-stub.mjs';

const summary = window => ({type:'steps', metric_version:'2026-11-16T08:00:00Z',
  timezone:'Asia/Shanghai', availability:'ok', summarizer_version:'along-health-v1',
  value:1200, unit:'count', window});
const envelope = window => ({event_id:'evt-window', schema_version:'1', event_type:'along.health_summary_updated',
  occurred_at:'2026-11-16T08:00:00Z', timezone:'Asia/Shanghai',
  payload:{event_type:'along.health_summary_updated', summaries:[summary(window)]}});

test('malformed health windows return a rejection reason instead of throwing', () => {
  for (const window of [true, 1, 'invalid', [], null, undefined, {}, {night:'2026-11-16T00:00:00Z'}]) {
    const input=envelope(window);
    assert.equal(typeof validateEnvelope(input),'string',`window ${JSON.stringify(window)} must be rejected`);
    assert.equal(assembleEnvelope(input).ok,false);
  }
  assert.equal(validateEnvelope(envelope({start:'2026-11-16T00:00:00Z',end:'2026-11-16T08:00:00Z'})),null);
  assert.equal(typeof validateEnvelope(envelope({start:'2026-11-17T00:00:00Z',end:'2026-11-16T08:00:00Z'})),'string');
  assert.equal(typeof validateEnvelope(envelope({start:'2026-11-16T00:00:00Z',end:'2026-11-16T08:00:00Z',samples:[]})),'string');
});

test('a malformed health window is rejected before persistence or network delivery', async () => {
  installDomStub();
  let requests=0;
  window.AlongAgentBridge={request:async()=>{requests++;throw Error('must not send');}};
  const config={userId:'u_window'};
  const result=await queueEvent(config,envelope('invalid'));
  assert.equal(result.ok,false);
  assert.equal(typeof result.reason,'string');
  assert.deepEqual(pendingEvents(config),[]);
  assert.equal(requests,0);
});
