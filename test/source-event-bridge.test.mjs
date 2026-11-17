import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createSourceJournal,createSourceEventBridge,createHostSourceEventBridge,sourceDigest} from '../host/source-event-bridge.mjs';
import {createOkxConnection} from '../host/okx-connection.mjs';
import {createBridge} from '../host/along-bridge.mjs';

const WHO={userId:'u_00112233',deviceId:'d_00112233'},GOAL='g_source_goal',OTHER='g_source_other',TOKEN='b'.repeat(64);
const CREDENTIALS={apiKey:'synthetic-source-key',secretKey:'synthetic-source-secret',passphrase:'synthetic-source-pass'};
const NOW=Date.parse('2026-11-18T01:00:00Z');
const response=data=>new Response(JSON.stringify({code:'0',data}),{headers:{'content-type':'application/json'}});
function temp(t){const dir=mkdtempSync(join(tmpdir(),'along-source-bridge-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
async function fixture(t,options={}){
 const dir=temp(t),state={now:NOW,equity:'1234.56',perm:'read_only',requests:[],events:[],results:[],calls:[],errors:[],goals:new Map([[GOAL,true],[OTHER,true]]),who:WHO};
 const journal=createSourceJournal({dir:join(dir,'events'),now:()=>state.now});
 const remote=async(url,opts)=>{
  state.calls.push({url,method:opts.method});
  const path=new URL(url).pathname;
  if(path==='/api/v5/public/time')return response([{ts:String(state.now)}]);
  if(path==='/api/v5/account/config')return response([{perm:state.perm}]);
  if(path==='/api/v5/account/balance')return response([{totalEq:state.equity,details:[{ccy:'USDT'}]}]);
  if(path==='/api/v5/account/positions')return response([]);
  throw Error('unexpected synthetic provider path');
 };
 const makeConnection=(sourceJournal=journal,fetchImpl=remote)=>createOkxConnection({dir:join(dir,'vault'),sourceJournal,fetchImpl,now:()=>state.now});
 const connection=makeConnection(options.journalOverride?.(journal)??journal);
 const detail=goal=>({goal:{id:goal,userId:WHO.userId,status:'active',currentRevision:1},revision:{goalId:goal,userId:WHO.userId,status:'active',revision:1},dataSources:state.goals.get(goal)?[{provider:'okx',status:'recommended'}]:[]});
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  assert.equal(req.headers['x-along-bridge'],'1');assert.equal(req.headers['x-along-bridge-token'],TOKEN);
  assert.equal(req.headers['x-along-user'],WHO.userId);assert.equal(req.headers['x-along-device'],WHO.deviceId);
  const url=new URL(req.url,'http://localhost'),path=url.pathname;let body;
  if(path==='/along-source/api/goals'){assert.equal(url.searchParams.get('user_id'),WHO.userId);body={items:[...state.goals.keys()].map(id=>({id}))};}
  else if(path.startsWith('/along-source/api/goals/'))body=detail(decodeURIComponent(path.split('/').at(-1)));
  else if(path==='/along-source/api/source-events'){
   const value=JSON.parse(raw);state.events.push(value);body=options.eventReceipt?options.eventReceipt(value):{event_id:value.event_id,status:'accepted'};
  }else if(path==='/along-source/api/source-reads'){assert.equal(req.method,'GET');assert.equal(url.searchParams.get('user_id'),WHO.userId);body={requests:state.requests};}
  else if(path==='/along-source/api/source-read-results'){
   const value=JSON.parse(raw);state.results.push(value);
   if(!options.keepRequests&&['ready','denied'].includes(value.state))state.requests=state.requests.filter(r=>r.request_id!==value.request_id);
   body=options.readReceipt?options.readReceipt(value):{request_id:value.request_id,status:'accepted'};
  }else{res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({error:'not_found'}));return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const endpoint='http://127.0.0.1:'+server.address().port,bridge=createBridge({url:endpoint,token:TOKEN});
 const makePump=(c=connection,j=journal,extra={})=>createHostSourceEventBridge({journal:j,connection:c,bridge,endpoint,identity:()=>state.who,now:()=>state.now,onError:code=>state.errors.push(code),...extra});
 const pump=makePump();t.after(()=>pump.close());
 const connect=(c=connection,goalId=GOAL)=>c.handle({userId:WHO.userId,goalId,input:{action:'connect',site:'global',credentials:CREDENTIALS},stillAuthorized:()=>state.goals.get(goalId)===true});
 const request=(id='read_1',current=journal.current(WHO.userId,GOAL),goalId=GOAL)=>({request_id:id,goal_id:goalId,provider:'okx',capability:'trading_account_summary',generation:current.generation,revision:current.revision,max_age_seconds:1800});
 return{dir,state,journal,connection,makeConnection,makePump,pump,connect,request,endpoint,bridge};
}

test('verified vault save emits only bound metadata over the private bridge; summaries require a specific authorized request',async t=>{
 const f=await fixture(t);await f.connect();await f.pump.pump();
 assert.equal(f.state.events.length,1);const event=f.state.events[0];
 assert.deepEqual(Object.keys(event).sort(),['capabilities','event_id','generation','goal_id','occurred_at','provider','reference','revision','state']);
 assert.equal(event.goal_id,GOAL);assert.equal(event.provider,'okx');assert.equal(event.state,'ready');assert.deepEqual(event.capabilities,['trading_account_summary']);
 assert.match(event.reference,/^src_[a-f0-9]+$/);assert.equal(f.state.results.length,0);
 const wire=JSON.stringify(event),disk=readFileSync(join(f.dir,'events','journal.json'),'utf8');
 for(const value of [...Object.values(CREDENTIALS),'1234.56','vault']){assert.ok(!wire.includes(value));assert.ok(!disk.includes(value));}
 f.state.requests=[f.request()];await f.pump.pump();
 assert.deepEqual(f.state.results[0].data,{tradingEquityUsd:1234.56,assetCount:1,positionCount:0});
 assert.equal(f.state.results[0].observed_at,new Date(NOW).toISOString());assert.equal(f.state.results[0].reference,event.reference);
 await f.pump.pump();assert.equal(f.state.events.length,1);assert.equal(f.state.results.length,1);
 assert.equal(statSync(join(f.dir,'events','journal.json')).mode&0o777,0o600);assert.equal(f.state.errors.length,0);
});

test('status and same-data refresh retries do not invent events; changed data advances revision without changing authorization epoch',async t=>{
 const f=await fixture(t);await f.connect();await f.pump.pump();const first=f.journal.current(WHO.userId,GOAL);
 for(let n=0;n<3;n++)await f.connection.handle({userId:WHO.userId,goalId:GOAL,input:{action:'status'}});
 f.state.now+=60_000;await f.connection.handle({userId:WHO.userId,goalId:GOAL,input:{action:'refresh'}});await f.pump.pump();
 assert.equal(f.state.events.length,1);assert.equal(f.journal.current(WHO.userId,GOAL).reference,first.reference);
 f.state.now+=60_000;f.state.equity='1300';await f.connection.handle({userId:WHO.userId,goalId:GOAL,input:{action:'refresh'}});await f.pump.pump();
 const last=f.journal.current(WHO.userId,GOAL);assert.equal(last.generation,first.generation);assert.ok(last.revision>first.revision);assert.equal(f.state.events.length,2);
});

test('a saved vault survives an interruption before outbox commit and restarts with exactly one stable ready event',async t=>{
 let failOnce=true;
 const f=await fixture(t,{journalOverride:j=>({...j,commitSaved(args){if(failOnce){failOnce=false;throw Error('synthetic interruption after save');}return j.commitSaved(args);}})});
 await f.connect();assert.equal(f.journal.outbox(WHO.userId).length,0);
 const persistedStamp=(await f.connection.handle({userId:WHO.userId,goalId:GOAL,input:{action:'status'}})).state;assert.equal(persistedStamp,'connected');
 const reopenedJournal=createSourceJournal({dir:join(f.dir,'events'),now:()=>f.state.now});
 const reopened=f.makeConnection(reopenedJournal,()=>{throw Error('recovery may not refresh network');}),pump=f.makePump(reopened,reopenedJournal);t.after(()=>pump.close());
 await pump.pump();assert.equal(f.state.events.length,1);const id=f.state.events[0].event_id;await pump.pump();assert.equal(f.state.events.length,1);assert.equal(f.state.events[0].event_id,id);
});

test('disconnect crash recovery invalidates old reads and a reconnect gets a later generation',async t=>{
 const f=await fixture(t);await f.connect();await f.pump.pump();const old=f.journal.current(WHO.userId,GOAL);
 let failOnce=true;const interrupted={...f.journal,commitAbsent(args){if(failOnce){failOnce=false;throw Error('synthetic disconnect interruption');}return f.journal.commitAbsent(args);}};
 await f.makeConnection(interrupted).handle({userId:WHO.userId,goalId:GOAL,input:{action:'disconnect'}});
 const reopenedJournal=createSourceJournal({dir:join(f.dir,'events'),now:()=>f.state.now}),reopened=f.makeConnection(reopenedJournal),pump=f.makePump(reopened,reopenedJournal);t.after(()=>pump.close());
 await pump.pump();assert.equal(f.state.events.at(-1).state,'disconnected');
 f.state.now+=1000;await f.connect(reopened);f.state.requests=[f.request('old_read',old)];await pump.pump();
 const latest=reopenedJournal.current(WHO.userId,GOAL);assert.ok(latest.generation>old.generation);assert.equal(f.state.results.at(-1).state,'denied');assert.equal(f.state.results.at(-1).generation,old.generation);assert.equal(f.state.results.at(-1).data,undefined);
 assert.throws(()=>reopenedJournal.recover({userId:WHO.userId,goalId:GOAL,stamp:{generation:old.generation,revision:old.revision,reference:old.reference,occurredAt:old.occurredAt},digest:old.digest}),/source bridge/);
 assert.equal(reopenedJournal.current(WHO.userId,GOAL).reference,latest.reference);
});

test('current goal withdrawal revokes credentials and old requests without using historical UI snapshots',async t=>{
 const f=await fixture(t);await f.connect();await f.pump.pump();const before=f.journal.current(WHO.userId,GOAL);
 f.state.goals.set(GOAL,false);f.state.requests=[f.request('withdrawn',before)];await f.pump.pump();
 assert.equal(f.state.events.at(-1).state,'revoked');assert.deepEqual(f.state.events.at(-1).capabilities,[]);
 assert.equal((await f.connection.handle({userId:WHO.userId,goalId:GOAL,input:{action:'status'}})).state,'disconnected');assert.equal(f.state.results.at(-1).state,'denied');assert.equal(f.state.results.at(-1).data,undefined);
 const count=f.state.events.length;await f.pump.pump();assert.equal(f.state.events.length,count);
});

test('stale pending reads recover after a real same-data refresh without a new source event or automatic network refresh',async t=>{
 const f=await fixture(t);await f.connect();await f.pump.pump();const old=f.journal.current(WHO.userId,GOAL),network=f.state.calls.length;
 f.state.now+=1900_000;f.state.requests=[f.request('stale_read')];await f.pump.pump();
 assert.equal(f.state.results.at(-1).state,'stale');assert.equal(f.state.results.at(-1).data,undefined);assert.equal(f.state.calls.length,network);
 f.state.now+=1000;await f.pump.pump();assert.equal(f.state.results.length,1);
 await f.connection.handle({userId:WHO.userId,goalId:GOAL,input:{action:'refresh'}});await f.pump.pump();
 assert.equal(f.state.events.length,1);assert.equal(f.journal.current(WHO.userId,GOAL).reference,old.reference);
 assert.equal(f.state.results.at(-1).state,'ready');assert.equal(f.state.results.at(-1).observed_at,new Date(f.state.now).toISOString());assert.equal(f.state.results.length,2);
});

test('a same-generation read follows a newer revision only after that fact is flushed',async t=>{
 const f=await fixture(t);await f.connect();await f.pump.pump();const old=f.journal.current(WHO.userId,GOAL);
 f.state.now+=1000;f.state.equity='1400';await f.connection.handle({userId:WHO.userId,goalId:GOAL,input:{action:'refresh'}});
 f.state.requests=[f.request('follow_new',old)];await f.pump.pump();
 assert.equal(f.state.events.at(-1).revision,f.state.results.at(-1).revision);assert.ok(f.state.results.at(-1).revision>old.revision);assert.equal(f.state.results.at(-1).data.tradingEquityUsd,1400);
});

test('foreign goal and malformed requests never receive summary data; pairing changes cancel delivery',async t=>{
 const f=await fixture(t);await f.connect();await f.pump.pump();const current=f.journal.current(WHO.userId,GOAL);
 f.state.goals.set(OTHER,false);f.state.requests=[f.request('foreign',current,OTHER),{...f.request('bad'),url:'https://evil.invalid'}];await f.pump.pump();
 assert.equal(f.state.results.length,1);assert.equal(f.state.results[0].state,'denied');assert.equal(f.state.results[0].data,undefined);assert.ok(f.state.errors.includes('invalid_read_request'));
 f.state.who=null;f.state.requests=[f.request('no_pair')];await f.pump.pump();assert.equal(f.state.results.length,1);
 assert.throws(()=>createSourceEventBridge({endpoint:'https://public.example',adapters:{},identity:()=>WHO}),/source bridge/);
});

// This source store is a synthetic admitted-native-summary seam, not an actual account or permission claim.
test('a persisted verified native producer can replace the vault adapter and recover lost hooks without copying credentials',async t=>{
 const f=await fixture(t),file=join(f.dir,'admitted-native.json');
 const summary={tradingEquityUsd:1250,assetCount:2,positionCount:1};
 const metadata={connectionId:'native_connection_A',version:1,state:'ready',observedAt:new Date(f.state.now).toISOString(),digest:sourceDigest(summary)};
 writeFileSync(file,JSON.stringify({metadata,summary}),{mode:0o600});
 const adapter={listGoals:async()=>[GOAL],lookup:async(_who,_goal,{metadataOnly})=>{const record=JSON.parse(readFileSync(file,'utf8'));return metadataOnly?{metadata:record.metadata}:record;}};
 const pump=f.makePump(undefined,f.journal,{adapters:{okx:adapter}});t.after(()=>pump.close());
 await pump.pump();assert.equal(f.state.events.length,1);assert.equal(f.state.events[0].state,'ready');
 assert.ok(!readdirSync(f.dir).includes('vault'));
 f.state.requests=[f.request('native_read')];await pump.pump();assert.equal(f.state.results.at(-1).data.tradingEquityUsd,1250);
 const current=f.journal.current(WHO.userId,GOAL);metadata.version=2;metadata.observedAt=new Date(f.state.now+1000).toISOString();writeFileSync(file,JSON.stringify({metadata,summary}),{mode:0o600});
 f.state.now+=1000;await pump.pump();assert.equal(f.state.events.length,1);assert.equal(f.journal.current(WHO.userId,GOAL).reference,current.reference);
});

test('verified producer versions cannot revive retired connections or reverse new authorization; provider identities stay separated',t=>{
 const journal=createSourceJournal({dir:temp(t),now:()=>NOW}),make=(connectionId,version,state='ready')=>({connectionId,version,state,observedAt:new Date(NOW).toISOString(),...(state==='ready'?{digest:'a'.repeat(64)}:{})});
 const first=journal.recordVerifiedState(WHO,GOAL,'okx',make('native_A',1));
 assert.equal(journal.recordVerifiedState(WHO,GOAL,'okx',make('native_A',1)).status,'duplicate');
 const disconnected=journal.recordVerifiedState(WHO,GOAL,'okx',make('native_A',2,'disconnected'));
 assert.ok(disconnected.sourceStamp.generation>first.sourceStamp.generation);
 assert.equal(journal.recordVerifiedState(WHO,GOAL,'okx',make('native_A',3)).status,'stale');
 const last=journal.recordVerifiedState(WHO,GOAL,'okx',make('native_B',1));
 assert.ok(last.sourceStamp.generation>disconnected.sourceStamp.generation);
 assert.equal(journal.recordVerifiedState(WHO,GOAL,'okx',make('native_A',99)).status,'stale');
 const another=journal.recordVerifiedState(WHO,OTHER,'okx',make('native_A',1));assert.equal(another.status,'accepted');
 assert.equal(journal.current(WHO.userId,GOAL).reference,last.sourceStamp.reference);
 assert.equal(journal.recordVerifiedState(WHO,GOAL,'health',make('native_A',1)).status,'accepted');
 assert.equal(journal.current(WHO.userId,GOAL).reference,last.sourceStamp.reference);
 assert.throws(()=>journal.recordVerifiedState(WHO,GOAL,'okx',{...make('native_C',1),credentials:CREDENTIALS}),/source bridge/);
});

test('a temporary current-goal lookup failure stays unavailable and the same bound request can recover',async t=>{
 const f=await fixture(t);await f.connect();await f.pump.pump();f.state.requests=[f.request('goal_retry')];
 let unavailable=true;
 const bridge={call(path,options){if(unavailable&&path==='/along-source/api/goals/'+GOAL)throw Error('synthetic transient goal service outage');return f.bridge.call(path,options);}};
 const pump=f.makePump(undefined,f.journal,{bridge});t.after(()=>pump.close());
 await pump.pump();assert.equal(f.state.results.at(-1).state,'unavailable');assert.equal(f.state.results.at(-1).data,undefined);assert.equal(f.state.requests.length,1);
 unavailable=false;await pump.pump();assert.equal(f.state.results.at(-1).state,'ready');assert.equal(f.state.results.at(-1).request_id,'goal_retry');
});

test('goal authorization lost while obtaining an admitted snapshot blocks its ready result',async t=>{
 const f=await fixture(t),data={tradingEquityUsd:1250,assetCount:1,positionCount:0};let withdraw=false,reads=0;
 const metadata={connectionId:'native_race',version:1,state:'ready',observedAt:new Date(f.state.now).toISOString(),digest:sourceDigest(data)};
 const adapter={listGoals:async()=>[GOAL],lookup:async()=>{if(withdraw&&++reads===2)f.state.goals.set(GOAL,false);return{metadata,summary:data};}};
 const pump=f.makePump(undefined,f.journal,{adapters:{okx:adapter}});t.after(()=>pump.close());
 await pump.pump();f.state.requests=[f.request('race_read')];withdraw=true;await pump.pump();
 assert.equal(f.state.results.at(-1).state,'denied');assert.equal(f.state.results.at(-1).data,undefined);
});

test('an unrelated event receipt cannot acknowledge the pending fact; only matching accepted or stale clears it',async t=>{
 let valid=false;
 const f=await fixture(t,{eventReceipt:value=>({event_id:valid?value.event_id:'unrelated_event',status:valid?'stale':'accepted'})});
 await f.connect();await f.pump.pump();assert.equal(f.journal.outbox(WHO.userId).length,1);assert.ok(f.state.errors.includes('invalid_source_receipt'));
 valid=true;await f.pump.pump();assert.equal(f.journal.outbox(WHO.userId).length,0);assert.equal(f.state.events[0].event_id,f.state.events[1].event_id);
});

test('a wrong read receipt remains retryable and a matching reused response acknowledges that exact request',async t=>{
 let valid=false;
 const f=await fixture(t,{keepRequests:true,readReceipt:value=>({request_id:valid?value.request_id:'unrelated_read',status:valid?'reused':'accepted'})});
 await f.connect();await f.pump.pump();f.state.requests=[f.request('receipt_read')];await f.pump.pump();
 assert.equal(f.state.results.length,1);assert.ok(f.state.errors.includes('invalid_read_receipt'));
 valid=true;await f.pump.pump();assert.equal(f.state.results.length,2);await f.pump.pump();assert.equal(f.state.results.length,2);
});
