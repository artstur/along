import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync,statSync,symlinkSync,chmodSync,writeFileSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSourceJournal} from '../host/source-event-bridge.mjs';
import {createDeviceSourceGateway,DeviceSourceError} from '../host/device-source-gateway.mjs';
import {createDeviceSourceRoute} from '../host/device-source-routes.mjs';

const NOW=Date.parse('2026-11-18T00:00:00Z'),SCOPE={userId:'u_test',deviceId:'d_test',goalId:'g_test'};
const SUMMARY={tradingEquityUsd:125.5,assetCount:2,positionCount:1};
// Actual production journal, wrapped only to inject cache-to-journal interruption.
function journalFixture(dir){
  const actual=createSourceJournal({dir,now:()=>NOW}),calls=[];let failure=false,absentFailure=false;
  return {actual,calls,get rows(){return new Map(actual.sources(SCOPE.userId).map(r=>[r.userId+':'+r.goalId,{current:r.current}]));},
    breakCommit(state='ready'){failure=state;},breakAbsent(){absentFailure=true;},
    recordVerifiedState(identity,goalId,provider,metadata){
      calls.push(['recordVerifiedState',metadata]);if(failure===metadata.state){failure=false;throw Error('remote-secret must never escape');}
      return actual.recordVerifiedState(identity,goalId,provider,metadata);
    },
    prepareAbsent(args){calls.push(['prepareAbsent',args]);return actual.prepareAbsent(args);},
    commitAbsent(args){calls.push(['commitAbsent',args]);if(absentFailure){absentFailure=false;throw Error('remote-secret');}return actual.commitAbsent(args);},
  };
}
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'along-device-gateway-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const journal=journalFixture(join(dir,'journal'));let time=NOW;
  const make=()=>createDeviceSourceGateway({dir:join(dir,'cache'),journal,now:()=>time});const gateway=make();
  const handle=(input,extra={})=>gateway.handle({...SCOPE,input:{provider:'okx',...input},...extra});
  let opens=0;const open=async(requestId='open_'+(++opens),expectedGrantId=undefined)=>handle({action:'open',requestId,expectedGrantId:expectedGrantId===undefined?(await handle({action:'context'})).currentGrantId:expectedGrantId});const publish=(grantId,extra={},context={})=>handle({action:'publish',grantId,eventId:'event_1',sequence:1,observedAt:new Date(time).toISOString(),permission:'read_only',summary:{...SUMMARY},...extra},context);
  return {dir,journal,gateway,make,handle,open,publish,time(n){time=n;}};
}
async function error(promise,code){await assert.rejects(promise,e=>{assert.ok(e instanceof DeviceSourceError);assert.equal(e.code,code);assert.doesNotMatch(e.message,/remote-secret|u_test|g_test|\.json/);return true;});}

test('context does not connect; open is pending and only trusted binding supplies identity',async t=>{
 const f=fixture(t);assert.deepEqual(await f.handle({action:'context'}),{...SCOPE,provider:'okx',currentGrantId:null});assert.equal(f.gateway.hasScope(SCOPE),false);
 const opened=await f.open();assert.equal(opened.state,'pending');assert.match(opened.grantId,/^[a-f0-9]{64}$/);assert.equal(opened.deviceId,SCOPE.deviceId);assert.equal(f.journal.calls.filter(x=>x[0]==='prepareReady').length,0);
 assert.equal(f.gateway.owned(SCOPE),true);assert.equal(f.gateway.owned({...SCOPE,deviceId:'d_other'}),false);assert.equal(await f.gateway.sourceSnapshot(SCOPE),null);
 await error(f.handle({action:'open',userId:'attacker'}),'invalid_request');await error(f.handle({action:'context',goalId:'other'}),'invalid_request');
});
test('publish validates exact protocol, stores private provenance and produces one idempotent source fact',async t=>{
 const f=fixture(t),{grantId}=await f.open();
 assert.deepEqual(await f.publish(grantId),{event_id:'event_1',status:'accepted'});assert.deepEqual(await f.publish(grantId),{event_id:'event_1',status:'duplicate'});
 assert.equal(f.journal.actual.outbox(SCOPE.userId).filter(x=>x.state==='ready').length,1);
 assert.equal(f.journal.calls.some(x=>['prepareReady','commitSaved'].includes(x[0])),false);
 const snapshot=await f.gateway.sourceSnapshot(SCOPE);assert.deepEqual(snapshot.summary,SUMMARY);assert.equal(snapshot.observedAt,new Date(NOW).toISOString());assert.equal(snapshot.sourceStamp.generation,2);
 assert.equal(await f.gateway.sourceSnapshot({...SCOPE,deviceId:undefined}),null);assert.equal(await f.gateway.sourceSnapshot({...SCOPE,deviceId:'d_other'}),null);
 assert.equal((await f.handle({action:'status'})).state,'connected');assert.equal((await f.handle({action:'status'},{deviceId:'d_other'})).state,'disconnected');
 const cache=join(f.dir,'cache'),file=join(cache,readdirSync(cache)[0]);assert.equal(statSync(cache).mode&0o777,0o700);assert.equal(statSync(file).mode&0o777,0o600);
 const stored=JSON.parse(readFileSync(file));assert.equal(stored.provenance,'ios-native-device-report');assert.equal(stored.permission,'read_only');assert.equal(stored.sourceStamp.reference,snapshot.sourceStamp.reference);
 snapshot.summary.tradingEquityUsd=0;assert.equal((await f.gateway.sourceSnapshot(SCOPE)).summary.tradingEquityUsd,SUMMARY.tradingEquityUsd);
 await error(f.publish(grantId,{summary:{...SUMMARY,tradingEquityUsd:2}}),'event_conflict');
});
test('strict schema refuses credentials, URLs, unknown summary fields, permissions and invalid times',async t=>{
 const f=fixture(t),{grantId}=await f.open();for(const extra of [{credentials:{secretKey:'remote-secret'}},{url:'https://example.com'},{sourceState:'ready'},{eventId:42},{permission:'read_only,trade'},{summary:{...SUMMARY,uid:'remote-secret'}},{summary:{...SUMMARY,assetCount:1.5}},{summary:{...SUMMARY,tradingEquityUsd:Infinity}},{sequence:0},{sequence:Number.MAX_SAFE_INTEGER+1},{observedAt:'invalid'},{observedAt:new Date(NOW+300001).toISOString()}])await error(f.publish(grantId,extra),'invalid_request');
 assert.equal(f.journal.calls.filter(x=>x[0]==='prepareReady').length,0);assert.equal((await f.handle({action:'status'})).state,'pending');
 await error(f.handle({action:'disconnect',grantId,eventId:'x',sequence:1,summary:SUMMARY}),'invalid_request');
});
test('old grants, sequences and devices cannot resurrect or delete a newer connection',async t=>{
 const f=fixture(t),old=await f.open();await f.publish(old.grantId);
 const next=await f.open();assert.notEqual(old.grantId,next.grantId);assert.equal(f.journal.rows.get('u_test:g_test').current.state,'disconnected');
 assert.equal((await f.publish(old.grantId,{eventId:'late',sequence:100})).status,'stale');
 await f.publish(next.grantId,{eventId:'new',sequence:2});
 assert.equal((await f.publish(next.grantId,{eventId:'older',sequence:1})).status,'stale');
 assert.equal((await f.handle({action:'disconnect',grantId:old.grantId,eventId:'old_disconnect',sequence:101})).status,'stale');
 assert.equal((await f.publish(next.grantId,{eventId:'wrong_device',sequence:3},{deviceId:'d_other'})).status,'stale');
 assert.equal((await f.handle({action:'publish',grantId:next.grantId,eventId:'new',sequence:2,observedAt:new Date(NOW).toISOString(),permission:'read_only',summary:SUMMARY},{deviceId:'d_other'})).status,'stale');
 assert.equal((await f.handle({action:'status'})).state,'connected');
 const command={action:'disconnect',grantId:next.grantId,eventId:'disconnect',sequence:3};assert.equal((await f.handle(command)).status,'accepted');assert.equal((await f.handle(command)).status,'duplicate');
 assert.equal((await f.publish(next.grantId,{eventId:'late_current',sequence:4})).status,'stale');assert.equal(await f.gateway.sourceSnapshot(SCOPE),null);
});
test('restart recovers save-before-journal interruption and duplicate receipts from persisted bytes',async t=>{
 const f=fixture(t),{grantId}=await f.open();f.journal.breakCommit();await error(f.publish(grantId),'storage_unavailable');
 assert.equal(f.journal.rows.get('u_test:g_test').current.state,'disconnected');const reopened=f.make();assert.deepEqual((await reopened.sourceSnapshot(SCOPE)).summary,SUMMARY);assert.equal(f.journal.rows.get('u_test:g_test').current.state,'ready');
 assert.equal((await reopened.handle({...SCOPE,input:{action:'publish',provider:'okx',grantId,eventId:'event_1',sequence:1,observedAt:new Date(NOW).toISOString(),permission:'read_only',summary:SUMMARY}})).status,'duplicate');
});
test('authorization changes reject saves, scope isolation and source bridge revocation remain private',async t=>{
 const f=fixture(t),{grantId}=await f.open();let count=0;await error(f.publish(grantId,{}, {stillAuthorized:()=>++count<2}),'stale_authorization');
 assert.equal((await f.handle({action:'status'})).state,'pending');
 await f.publish(grantId);assert.equal(await f.gateway.sourceSnapshot({...SCOPE,goalId:'other'}),null);
 assert.equal(await f.gateway.handle({userId:'other',goalId:SCOPE.goalId,input:{action:'disconnect'},sourceState:'revoked'}),null);
 await f.gateway.handle({...SCOPE,deviceId:undefined,input:{action:'disconnect'},sourceState:'revoked',revokeIf:()=>false});assert.equal((await f.handle({action:'status'})).state,'connected');
 await f.gateway.handle({...SCOPE,deviceId:undefined,input:{action:'disconnect'},sourceState:'revoked',revokeIf:()=>true});assert.equal((await f.handle({action:'status'})).state,'disconnected');
 await error(f.gateway.sourceSnapshot({...SCOPE,stillAuthorized:()=>false}),'stale_authorization');
});
test('cache rejects symlinks, hardlinks, broad permissions and corrupt state',async t=>{
 for(const attack of ['symlink','hardlink','mode','json']){const f=fixture(t);await f.open();const dir=join(f.dir,'cache'),file=join(dir,readdirSync(dir)[0]);
  if(attack==='mode')chmodSync(file,0o644);else if(attack==='json')writeFileSync(file,'{}');else{const original=join(f.dir,'original');if(attack==='hardlink')linkSync(file,original);else{writeFileSync(original,'secret',{mode:0o600});rmSync(file);symlinkSync(original,file);}}
  await error(f.handle({action:'status'}),'storage_unavailable');
 }
});
test('same scope operations serialize across gateway instances while authorization is awaiting',async t=>{
 const f=fixture(t),{grantId}=await f.open();let release,entered;const wait=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});let calls=0;
 const publishing=f.publish(grantId,{}, {stillAuthorized:async()=>{if(++calls===1){entered();await wait;}return true;}});await started;
 const reopened=f.make();const rotating=reopened.handle({...SCOPE,input:{action:'open',provider:'okx',requestId:'open_later',expectedGrantId:grantId}});release();await publishing;const newer=await rotating;
 assert.notEqual(newer.grantId,grantId);assert.equal(newer.state,'pending');assert.equal(await reopened.sourceSnapshot(SCOPE),null);assert.equal(f.journal.rows.get('u_test:g_test').current.state,'disconnected');
});

test('open request retries are stable; replacement and restart never restore the older grant or summary',async t=>{
 const f=fixture(t),old=await f.open('open_original');await f.publish(old.grantId);
 const before=f.journal.calls.filter(x=>x[0]==='prepareAbsent').length;
 assert.equal((await f.open('open_original')).grantId,old.grantId);assert.equal(f.journal.calls.filter(x=>x[0]==='prepareAbsent').length,before);
 f.journal.breakAbsent();await error(f.open('open_replacement'),'storage_unavailable');
 const reopened=f.make();assert.equal(await reopened.sourceSnapshot(SCOPE),null);assert.equal(f.journal.rows.get('u_test:g_test').current.state,'disconnected');
 const next=await reopened.handle({...SCOPE,input:{action:'open',provider:'okx',requestId:'open_replacement',expectedGrantId:old.grantId}});assert.notEqual(next.grantId,old.grantId);assert.equal(next.state,'pending');
 const replay=await f.open('open_original');assert.equal(replay.grantId,old.grantId);assert.equal(replay.state,'disconnected');assert.equal((await f.handle({action:'status'})).grantId,next.grantId);
 assert.equal((await f.publish(old.grantId,{eventId:'old_late',sequence:90})).status,'stale');
 await error(f.handle({action:'open',requestId:'open_replacement',expectedGrantId:old.grantId},{deviceId:'d_other'}),'stale_authorization');
});

test('disconnect survives interruption after cache clear, and future freshness remains explicit',async t=>{
 const f=fixture(t),{grantId}=await f.open();await f.publish(grantId,{observedAt:new Date(NOW+300000).toISOString()});
 assert.equal((await f.gateway.sourceSnapshot(SCOPE)).observedAt,new Date(NOW+300000).toISOString());
 f.journal.breakCommit('disconnected');const command={action:'disconnect',grantId,eventId:'clear_interrupted',sequence:2};await error(f.handle(command),'storage_unavailable');
 const reopened=f.make();assert.equal(await reopened.sourceSnapshot(SCOPE),null);assert.equal(f.journal.rows.get('u_test:g_test').current.state,'disconnected');
 assert.equal((await reopened.handle({...SCOPE,input:{provider:'okx',...command}})).status,'duplicate');
});

test('queued calls snapshot validated input and ordinary legal ids never resolve Object prototype properties',async t=>{
 const f=fixture(t),opened=await f.open('constructor');
 let release,entered;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});let calls=0;
 const input={action:'publish',provider:'okx',grantId:opened.grantId,eventId:'constructor',sequence:1,observedAt:new Date(NOW).toISOString(),permission:'read_only',summary:{...SUMMARY}};
 const pending=f.gateway.handle({...SCOPE,input,stillAuthorized:async()=>{if(++calls===1){entered();await gate;}return true;}});await started;
 input.summary.tradingEquityUsd=999;input.permission='trade';release();assert.equal((await pending).status,'accepted');
 assert.deepEqual((await f.gateway.sourceSnapshot(SCOPE)).summary,SUMMARY);
});

test('status resolves a lost open response without rotating grants or revealing a newer intent summary',async t=>{
 const f=fixture(t),first=await f.open('first_intent');
 const reopened=f.make();const status=(requestId,deviceId=SCOPE.deviceId)=>reopened.handle({...SCOPE,deviceId,input:{action:'status',provider:'okx',requestId}});
 assert.deepEqual(await status('first_intent'),{provider:'okx',state:'pending',grantId:first.grantId});
 await f.publish(first.grantId);const newer=await f.open('newer_intent');await f.publish(newer.grantId,{eventId:'newer_read',summary:{...SUMMARY,tradingEquityUsd:999}});
 const before=JSON.stringify([...f.journal.rows]),reservations=f.journal.calls.filter(x=>x[0]==='prepareAbsent').length;
 const current=await status('newer_intent');assert.equal(current.grantId,newer.grantId);assert.equal(current.summary.tradingEquityUsd,999);
 assert.deepEqual(await status('first_intent'),{provider:'okx',state:'disconnected',grantId:first.grantId});
 assert.deepEqual(await status('unknown_intent'),{provider:'okx',state:'disconnected'});
 assert.deepEqual(await status('constructor'),{provider:'okx',state:'disconnected'});
 assert.deepEqual(await status('newer_intent','d_old'),{provider:'okx',state:'disconnected'});
 assert.deepEqual(await status('first_intent','d_old'),{provider:'okx',state:'disconnected'});
 assert.equal(JSON.stringify([...f.journal.rows]),before);assert.equal(f.journal.calls.filter(x=>x[0]==='prepareAbsent').length,reservations);
 assert.equal((await f.handle({action:'disconnect',grantId:first.grantId,eventId:'late_revoke',sequence:10})).status,'stale');
 assert.equal((await status('newer_intent')).state,'connected');
 await error(status(42),'invalid_request');await error(f.handle({action:'status',requestId:'newer_intent',grantId:newer.grantId}),'invalid_request');
});

test('actual journal maps native metadata versions without creating repeated same-value source facts',async t=>{
 const f=fixture(t),{grantId}=await f.open();await f.publish(grantId);const first=await f.gateway.sourceSnapshot(SCOPE),event=f.journal.actual.outbox(SCOPE.userId)[0];
 assert.deepEqual(first.metadata,{connectionId:grantId,version:1,state:'ready',observedAt:new Date(NOW).toISOString(),digest:f.journal.rows.get('u_test:g_test').current.digest});
 f.time(NOW+60000);await f.publish(grantId,{eventId:'same_value',sequence:2});const same=await f.gateway.sourceSnapshot(SCOPE);
 assert.equal(same.metadata.version,2);assert.equal(same.observedAt,new Date(NOW+60000).toISOString());assert.deepEqual(same.sourceStamp,first.sourceStamp);assert.equal(f.journal.actual.outbox(SCOPE.userId)[0].event_id,event.event_id);
 await f.publish(grantId,{eventId:'new_value',sequence:3,summary:{...SUMMARY,tradingEquityUsd:130}});const changed=await f.gateway.sourceSnapshot(SCOPE);
 assert.equal(changed.sourceStamp.generation,first.sourceStamp.generation);assert.ok(changed.sourceStamp.revision>first.sourceStamp.revision);assert.equal(changed.metadata.version,3);
 assert.equal(f.journal.calls.some(([name])=>['prepareReady','commitSaved'].includes(name)),false);
});

test('actual journal retirement suppresses stale admitted summaries and cannot revive the same grant',async t=>{
 const f=fixture(t),{grantId}=await f.open();await f.publish(grantId);
 const result=f.journal.actual.recordVerifiedState(SCOPE,SCOPE.goalId,'okx',{connectionId:grantId,version:2,state:'revoked',observedAt:new Date(NOW).toISOString()});assert.equal(result.status,'accepted');
 assert.equal(await f.gateway.sourceSnapshot(SCOPE),null);assert.equal((await f.handle({action:'status'})).summary,undefined);
 assert.equal((await f.publish(grantId)).status,'stale');assert.equal((await f.publish(grantId,{eventId:'after_retirement',sequence:3})).status,'stale');
 const reopened=f.make();assert.equal(await reopened.sourceSnapshot(SCOPE),null);
 const next=await f.open();await f.publish(next.grantId,{eventId:'after_new_grant'});assert.deepEqual((await f.gateway.sourceSnapshot(SCOPE)).summary,SUMMARY);
});

test('a genuinely late unknown open cannot revoke a newer grant; known intent retries precede CAS',async t=>{
 const f=fixture(t),initial=(await f.handle({action:'context'})).currentGrantId;assert.equal(initial,null);
 let release;const gate=new Promise(r=>{release=r;});
 const late=gate.then(()=>f.handle({action:'open',requestId:'delayed_open',expectedGrantId:initial}));
 const current=await f.open('arrived_first',initial);await f.publish(current.grantId);
 const before=f.journal.actual.current(SCOPE.userId,SCOPE.goalId);release();await error(late,'stale_authorization');
 assert.equal((await f.handle({action:'context'})).currentGrantId,current.grantId);assert.equal((await f.handle({action:'status'})).state,'connected');assert.deepEqual(f.journal.actual.current(SCOPE.userId,SCOPE.goalId),before);
 assert.equal((await f.handle({action:'open',requestId:'arrived_first',expectedGrantId:null})).grantId,current.grantId);
 await error(f.handle({action:'open',requestId:'missing_expected'}),'invalid_request');
 for(const expectedGrantId of [undefined,42,'short',{},'z'.repeat(64)])await error(f.handle({action:'open',requestId:'invalid_expected',expectedGrantId}),'invalid_request');
});

test('actual route preflight delay cannot allow an old open to rotate the grant after a newer request',async t=>{
 const f=fixture(t);let release,entered,first=true;
 const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 const route=createDeviceSourceRoute({gateway:f.gateway,stillBound:()=>true,readGoal:async()=>{
  if(first){first=false;entered();await gate;}
  return {goal:{id:SCOPE.goalId,userId:SCOPE.userId,status:'active',currentRevision:1},revision:{goalId:SCOPE.goalId,userId:SCOPE.userId,status:'active',revision:1},dataSources:[{provider:'okx',status:'recommended'}]};
 }});
 const late=route({action:'open',provider:'okx',goalId:SCOPE.goalId,requestId:'slow_route_open',expectedGrantId:null},SCOPE);await started;
 const current=await route({action:'open',provider:'okx',goalId:SCOPE.goalId,requestId:'fast_route_open',expectedGrantId:null},SCOPE);await f.publish(current.value.grantId);
 const before=f.journal.actual.current(SCOPE.userId,SCOPE.goalId);release();await error(late,'stale_authorization');
 assert.equal((await f.handle({action:'status'})).grantId,current.value.grantId);assert.equal((await f.handle({action:'status'})).state,'connected');assert.deepEqual(f.journal.actual.current(SCOPE.userId,SCOPE.goalId),before);
});

test('more than 2048 actual grant opens stay usable and evicted old intents cannot rotate after restart',async t=>{
 const f=fixture(t);let current=null,firstGrant;
 for(let n=0;n<2051;n++){
  const opened=await f.handle({action:'open',requestId:String(2051-n),expectedGrantId:current});
  if(n===0)firstGrant=opened.grantId;current=opened.grantId;
 }
 const cache=join(f.dir,'cache'),file=join(cache,readdirSync(cache)[0]),disk=JSON.parse(readFileSync(file));
 assert.equal(Object.keys(disk.opens).length,2048);assert.equal(disk.openOrder.length,2048);assert.equal(disk.openOrder[0],'2048');assert.equal(disk.openOrder.at(-1),'1');assert.equal(Object.hasOwn(disk.opens,'2051'),false);
 const reopened=f.make();await error(reopened.handle({...SCOPE,input:{action:'open',provider:'okx',requestId:'2051',expectedGrantId:null}}),'stale_authorization');
 assert.equal((await f.handle({action:'context'})).currentGrantId,current);assert.notEqual(current,firstGrant);
 await f.publish(current,{eventId:'after_many_opens'});assert.equal((await f.handle({action:'status'})).state,'connected');
 const replaced=await f.open('new_after_boundary',current);assert.notEqual(replaced.grantId,current);assert.equal(Object.keys(JSON.parse(readFileSync(file)).events).length,0);
});

test('more than 2048 actual events stay usable; evicted old sequences cannot restore data or block disconnect',async t=>{
 const f=fixture(t),{grantId}=await f.open();
 for(let sequence=1;sequence<=2051;sequence++)assert.equal((await f.publish(grantId,{eventId:String(2052-sequence),sequence})).status,'accepted');
 const cache=join(f.dir,'cache'),file=join(cache,readdirSync(cache)[0]),disk=JSON.parse(readFileSync(file));
 assert.equal(Object.keys(disk.events).length,2048);assert.equal(disk.eventOrder[0],'2048');assert.equal(disk.eventOrder.at(-1),'1');assert.equal(Object.hasOwn(disk.events,'2051'),false);
 const before=f.journal.actual.current(SCOPE.userId,SCOPE.goalId);
 assert.equal((await f.publish(grantId,{eventId:'2051',sequence:1})).status,'stale');assert.equal((await f.publish(grantId,{eventId:'2051',sequence:1,summary:{...SUMMARY,tradingEquityUsd:9}})).status,'stale');
 assert.deepEqual(f.journal.actual.current(SCOPE.userId,SCOPE.goalId),before);
 assert.equal((await f.publish(grantId,{eventId:'1',sequence:2051})).status,'duplicate');
 assert.equal((await f.handle({action:'disconnect',grantId,eventId:'after_many_events_disconnect',sequence:2052})).status,'accepted');assert.equal(await f.gateway.sourceSnapshot(SCOPE),null);
});
