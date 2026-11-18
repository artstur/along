import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDeviceSourceGateway} from '../host/device-source-gateway.mjs';
import {createSourceJournal,createSourceEventBridge} from '../host/source-event-bridge.mjs';
import {history,END} from './fixtures/okx-history.mjs';
const WHO={userId:'u_history',deviceId:'d_history'},GOAL='g_history',SUMMARY={tradingEquityUsd:123,assetCount:2,positionCount:1};
async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'along-history-bridge-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const state={now:Date.parse(END)+1000,events:[],results:[],requests:[]};
  const journal=createSourceJournal({dir:join(dir,'journal'),now:()=>state.now});
  const make=()=>createDeviceSourceGateway({dir:join(dir,'cache'),journal,now:()=>state.now});let gateway=make();
  const handle=input=>gateway.handle({...WHO,goalId:GOAL,input:{provider:'okx',goalId:GOAL,...input}});
  const opened=await handle({action:'open',requestId:'open_history',expectedGrantId:null});
  const bridge={async call(path,options){
    if(path==='/along-source/api/source-events'){state.events.push(options.value);return {event_id:options.value.event_id,status:'accepted'};}
    if(path.startsWith('/along-source/api/source-reads?'))return {requests:state.requests};
    if(path==='/along-source/api/source-read-results'){state.results.push(options.value);state.requests=[];return {request_id:options.value.request_id,status:'accepted'};}
    throw Error('unexpected fixture call');
  }};
  const pump=createSourceEventBridge({journal,connection:{hasSavedSource:()=>true,sourceSnapshot:()=>gateway.sourceSnapshot({...WHO,goalId:GOAL}),handle:args=>gateway.handle({...args,deviceId:WHO.deviceId})},
    bridge,endpoint:'http://127.0.0.1:3999',identity:()=>WHO,isAuthorized:()=>true,readGoals:()=>[GOAL],now:()=>state.now,onError:e=>{throw Error(e);}});
  t.after(()=>pump.close());
  const publish=(sequence,extra={})=>handle({action:'publish',grantId:opened.grantId,eventId:'history_'+sequence,sequence,observedAt:new Date(state.now).toISOString(),permission:'read_only',summary:SUMMARY,...extra});
  const read=async(capability,id,maxAge=1800)=>{const s=journal.current(WHO.userId,GOAL);state.requests=[{request_id:id,goal_id:GOAL,provider:'okx',capability,generation:s.generation,revision:s.revision,max_age_seconds:maxAge}];await pump.pump();return state.results.at(-1);};
  return {dir,state,journal,handle,publish,pump,read,restart(){gateway=make();},grantId:opened.grantId};
}

test('native history admission updates metadata-only capability and serves deterministic scoped report, preserving summary-only callers',async t=>{
  const f=await fixture(t);await f.publish(1);await f.pump.pump();const old=f.journal.current(WHO.userId,GOAL);
  assert.deepEqual(f.state.events.at(-1).capabilities,['trading_account_summary']);
  await f.publish(2,{history:history()});f.restart();await f.pump.pump();const current=f.journal.current(WHO.userId,GOAL);
  assert.equal(current.generation,old.generation);assert.ok(current.revision>old.revision);
  assert.deepEqual(f.state.events.at(-1).capabilities,['trading_account_summary','trading_history']);
  const metadata=JSON.stringify(f.state.events)+readFileSync(join(f.dir,'journal','journal.json'),'utf8');
  assert.ok(!metadata.includes('9007199254740993123'));assert.ok(!metadata.includes('feeCashflow'));assert.ok(!metadata.includes('BTC-USDT-SWAP'));
  assert.ok(!Object.hasOwn(await f.handle({action:'status'}),'history'));
  const result=await f.read('trading_history','read_history');assert.equal(result.state,'ready');assert.equal(result.observed_at,END);
  assert.equal(result.data.groups.bills.find(g=>g.instType==='SWAP').tradeNet,'9.9');assert.equal(result.data.coverage.complete,true);
  assert.equal(result.reference,current.reference);assert.equal(result.revision,current.revision);
  const summary=await f.read('trading_account_summary','read_summary');assert.deepEqual(summary.data,SUMMARY);
  assert.equal(statSync(join(f.dir,'cache',readdirSync(join(f.dir,'cache'))[0])).mode&0o777,0o600);
});
test('history uses its own window freshness, receipt conflicts are rejected and revoke removes every private row',async t=>{
  const f=await fixture(t);await f.publish(1,{history:history()});await f.pump.pump();
  await assert.rejects(f.publish(1,{history:history({fills:[]})}),e=>e.code==='event_conflict');
  f.state.now+=120000;await f.publish(2,{history:history()});await f.pump.pump();
  assert.equal((await f.read('trading_history','history_stale',60)).state,'stale');assert.equal((await f.read('trading_account_summary','summary_fresh',60)).state,'ready');
  await f.handle({action:'disconnect',grantId:f.grantId,eventId:'history_disconnect',sequence:3});await f.pump.pump();
  assert.equal(f.state.events.at(-1).state,'disconnected');assert.deepEqual(f.state.events.at(-1).capabilities,[]);
  assert.equal((await f.read('trading_history','after_revoke')).state,'denied');
  const bytes=readFileSync(join(f.dir,'cache',readdirSync(join(f.dir,'cache'))[0]),'utf8');assert.ok(!bytes.includes('9007199254740993123'));assert.equal(Object.hasOwn(JSON.parse(bytes),'history'),false);
});
test('strict native admission never upgrades a malformed/credential-bearing history',async t=>{
  const f=await fixture(t),h=history();h.bills[0].secretKey='fixture-only-rejected';
  await assert.rejects(f.publish(1,{history:h}),e=>e.code==='invalid_request');await f.pump.pump();assert.ok(!f.state.events.some(e=>e.capabilities.includes('trading_history')));
  assert.equal((await f.handle({action:'status'})).state,'pending');
});
test('journal revocation of history remains readable across repeated recovery and permits a new connection',async t=>{
  const f=await fixture(t);await f.publish(1,{history:history()});
  const stamp=f.journal.prepareAbsent({userId:WHO.userId,goalId:GOAL,state:'revoked'});
  f.journal.commitAbsent({userId:WHO.userId,goalId:GOAL,stamp});
  assert.equal((await f.handle({action:'status'})).state,'disconnected');f.restart();
  assert.equal((await f.handle({action:'status'})).state,'disconnected');
  const next=await f.handle({action:'open',requestId:'reopen_history',expectedGrantId:f.grantId});
  assert.equal(next.state,'pending');assert.notEqual(next.grantId,f.grantId);
});
test('all history endpoints failing cannot advertise a ready history capability or fulfill a queued history read',async t=>{
  const f=await fixture(t);const h=history({fills:[],bills:[]});h.streams=h.streams.map(s=>({...s,status:'unavailable',reason:'api_unavailable',pages:0}));
  await f.publish(1,{history:h});await f.pump.pump();f.restart();
  assert.deepEqual(f.state.events.at(-1).capabilities,['trading_account_summary']);
  assert.equal((await f.read('trading_history','unavailable_history')).state,'denied');
  assert.deepEqual((await f.read('trading_account_summary','available_summary')).data,SUMMARY);
});
