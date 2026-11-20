import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';

test('the paired Host registers notification devices and dispatches without a phone sync',()=>{
  const source=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');
  assert.ok(source.includes("'/notifications/device'"),'missing paired registration endpoint');
  assert.match(source,/setInterval\(.*dispatchNotifications/);
});

import {mkdtempSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {taskNotifications} from '../host/task-notifications.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'along-notes-'));
  t.after(()=>rmSync(dir,{force:true,recursive:true}));
  const who={userId:'u_test',deviceId:'d_test'};
  let clock=Date.UTC(2026,9,11,1);
  const pages=[],sent=[];
  const options={dir,userId:'u_test',binding:()=>who,now:()=>clock,
    readPage:async (_,cursor)=>({items:pages.filter(item=>item.seq>cursor)}),
    send:async (device,route)=>{sent.push(route);return 'accepted';}};
  const input={token:'ab'.repeat(32),environment:'development',expectedUserId:who.userId};
  const item=(seq,kind='recommendation_ready')=>({
    seq,createdAt:new Date(clock+1).toISOString(),userId:who.userId,goalId:'g_test',taskId:'t_test',
    payload:{notification:{kind,event_id:'event:'+seq,revision:2},snapshot:{
      goal:{id:'g_test',status:'active',currentRevision:2},tasks:[{id:'t_test',goalId:'g_test',status:'open',currentRevision:2,content:'private task'}]}}});
  return {options,dir,input,who,pages,sent,item,tick:ms=>{clock+=ms;}};
}
test('offline retry, duplicate event, process restart and repeated phone sync preserve one routing receipt',async t=>{
  const f=fixture(t);
  const one=taskNotifications(f.options);
  one.register(f.who,f.input);
  f.pages.push(f.item(1),f.item(2,'task_result'));
  f.pages[1].payload.notification=f.pages[0].payload.notification;
  const receipt=one.decorate(f.who,{items:f.pages});
  assert.equal(receipt.items[0].remoteNotifications,true);
  const offline=taskNotifications({...f.options,send:async()=>{throw Error('offline');}});
  await offline.dispatch();
  f.tick(3000);
  const two=taskNotifications(f.options);
  await Promise.all([two.dispatch(),two.dispatch()]);
  await taskNotifications(f.options).dispatch();
  assert.deepEqual(f.sent,[{userId:'u_test',goalId:'g_test',taskId:'t_test',kind:'recommendation_ready',eventId:'event:1',revision:2}]);
  assert.deepEqual(two.decorate(f.who,{items:f.pages}),receipt);
  assert.equal(statSync(join(f.dir,'notification-device.u_test.json')).mode&0o777,0o600);
});
test('a Mac upgrade resumes the matching device cursor, queue and schedule',async t=>{
  const f=fixture(t),legacyFile=join(f.dir,'notification-device.json');
  const item=f.item(49);
  const state={...f.who,token:f.input.token,environment:f.input.environment,enabledAt:f.options.now()-1,cursor:49,
    seen:[{id:'event:48',expires:f.options.now()+10_000}],
    queue:[{route:{userId:f.who.userId,goalId:item.goalId,taskId:item.taskId,eventId:'event:49',revision:2,kind:'recommendation_ready'},
      attempts:0,createdAt:item.createdAt,expires:f.options.now()+10_000}],
    scheduled:[{goalId:item.goalId,taskId:item.taskId,revision:2,scheduledAt:new Date(f.options.now()+20_000).toISOString()}]};
  writeFileSync(legacyFile,JSON.stringify(state),{mode:0o600});
  const other={...f.who,deviceId:'d_other'};
  assert.equal(taskNotifications({...f.options,migrateLegacy:true,binding:()=>other}).active(other),false);
  assert.equal(taskNotifications(f.options).active(f.who),false);
  assert.ok(existsSync(legacyFile));
  const cursors=[];
  const service=taskNotifications({...f.options,migrateLegacy:true,readPage:async(_who,cursor)=>{cursors.push(cursor);return {items:[]};}});
  assert.equal(service.active(f.who),true);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir,'notification-device.u_test.json'),'utf8')),state);
  assert.equal(existsSync(legacyFile),false);
  await service.dispatch();
  assert.deepEqual(cursors,[49]);
  assert.deepEqual(f.sent.map(route=>route.eventId),['event:49']);
  assert.equal(taskNotifications(f.options).active(f.who),true);
});
test('only fresh, explicit and still relevant notices owned by this device are sent',async t=>{
  const f=fixture(t),service=taskNotifications(f.options);
  const before=f.item(1);
  f.tick(2000);
  service.register(f.who,f.input);
  f.pages.push(before,f.item(2),f.item(3),f.item(4),f.item(5,'task_result'));
  delete f.pages[1].payload.notification;
  f.pages[2].payload.snapshot.tasks[0].status='cancelled';
  f.pages[3].payload.snapshot.goal.status='archived';
  f.pages[4].payload.snapshot.tasks[0].status='done';
  f.pages[4].payload.calculation_receipt_id='calc_'+'a'.repeat(40);
  f.pages[4].payload.snapshot.tasks[0].execution={version:1,count:1,records:[{kind:'calculation',outcome:'calculated',calculationReceiptId:f.pages[4].payload.calculation_receipt_id}]};
  assert.equal(service.decorate(f.who,{items:[before]}).items[0].remoteNotifications,false);
  await service.dispatch();
  assert.deepEqual(f.sent.map(item=>item.eventId),['event:5']);
  f.pages.push(f.item(6));
  f.tick(11*60_000);
  await service.dispatch();
  assert.equal(f.sent.length,1);
});
test('revocation during fetch, re-pairing, absent provider and invalid device stay scoped',async t=>{
  const f=fixture(t);
  let resolve;
  const service=taskNotifications({...f.options,readPage:()=>new Promise(r=>{resolve=r;})});
  assert.throws(()=>service.register(f.who,{...f.input,expectedUserId:'other'}),/绑定/);
  service.register(f.who,f.input);
  const flight=service.dispatch();
  assert.equal(service.register(f.who,{expectedUserId:f.who.userId,enabled:false}).remoteNotifications,false);
  resolve({items:[f.item(1)]});
  await flight;
  assert.equal(f.sent.length,0);
  service.register(f.who,f.input);
  assert.equal(service.decorate({...f.who,deviceId:'new'},{items:[]}).remoteNotifications,false);
  const disabled=taskNotifications({...f.options,send:null});
  assert.equal(disabled.register(f.who,f.input).remoteNotifications,false);
  const invalid=taskNotifications({...f.options,send:async()=>'invalid_device'});
  f.pages.push(f.item(1));
  await invalid.dispatch();
  assert.equal(invalid.decorate(f.who,{items:f.pages}).remoteNotifications,false);
});

import {generateKeyPairSync,verify} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {createApnsProvider} from '../host/apns.mjs';
test('Apple request uses ES256, the signed environment and a generic alert with a stable collapse ID',async t=>{
  const f=fixture(t);
  const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const path=join(f.dir,'test.p8');
  writeFileSync(path,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const env={ALONG_APNS_KEY_FILE:path,ALONG_APNS_TEAM_ID:'ABCDEFGHIJ',ALONG_APNS_KEY_ID:'1234567890'};
  const requests=[];
  const provider=createApnsProvider(env,authority=>{
    const client=new EventEmitter();
    client.unref=()=>{};
    client.request=headers=>{
      const stream=new EventEmitter();
      stream.setEncoding=()=>{};
      stream.end=data=>{
        requests.push({authority,headers,body:JSON.parse(data)});
        stream.emit('response',{':status':200});
        stream.emit('end');
      };
      return stream;
    };
    return client;
  });
  const route={userId:f.who.userId,eventId:'result:1',goalId:'g1',revision:1,kind:'task_result'};
  for (let i=0;i<2;i++) assert.equal(await provider(f.input,route,Date.now()+60000),'accepted');
  const {headers,body,authority}=requests[0];
  assert.equal(authority,'https://api.sandbox.push.apple.com');
  assert.equal(headers['apns-topic'],'com.artstur.AlongHealth');
  assert.equal(headers['apns-push-type'],'alert');
  assert.equal(headers['apns-collapse-id'],requests[1].headers['apns-collapse-id']);
  assert.deepEqual(body,{aps:{alert:{title:'Along 任务有了结果',body:'打开查看详情'},sound:'default'},along:route});
  const [head,claims,sig]=headers.authorization.slice(7).split('.');
  assert.equal(JSON.parse(Buffer.from(head,'base64url')).alg,'ES256');
  assert.equal(JSON.parse(Buffer.from(claims,'base64url')).iss,env.ALONG_APNS_TEAM_ID);
  assert.equal(verify('sha256',Buffer.from(head+'.'+claims),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url')),true);
});

test('APNs refusal after a phone sync can hand off on an empty page until the phone acknowledges',async t=>{
  const f=fixture(t);
  const first=taskNotifications({...f.options,send:async()=>'invalid_device'});
  first.register(f.who,f.input);
  f.pages.push(f.item(1));
  assert.equal(first.decorate(f.who,{items:f.pages}).items[0].remoteNotifications,true);
  await first.dispatch();
  const next=taskNotifications(f.options);
  const sync=receipts=>next.decorate(f.who,{items:[]},{notificationFallback:true,notificationReceipts:receipts});
  assert.equal(sync([]).notificationFallback[0].eventId,'event:1');
  next.register(f.who,f.input);
  f.tick(4000);
  await next.dispatch();
  assert.equal(f.sent.length,0);
  assert.equal(sync([]).notificationFallback.length,1);
  assert.deepEqual(sync(['event:1']).notificationFallback,[]);
  assert.equal(next.decorate(f.who,{items:f.pages}).items[0].remoteNotifications,true);
});
test('a newer task revision supersedes both queued recommendation and task-result retries',async t=>{
  const f=fixture(t);
  let offline=true;
  const one=taskNotifications({...f.options,send:async(...args)=>{
    if (offline) throw Error('offline');
    return f.options.send(...args);
  }});
  one.register(f.who,f.input);
  f.pages.push(f.item(1),f.item(2,'task_result'));
  await one.dispatch();
  const updated=f.item(3);
  updated.payload.notification.revision=3;
  updated.payload.snapshot.tasks[0].currentRevision=3;
  f.pages.push(updated);
  f.tick(4000);offline=false;
  await one.dispatch();
  assert.deepEqual(f.sent.map(n=>n.eventId),['event:3']);
});
test('an actual iOS scheduling receipt suppresses the same due occurrence; an unseen next-day task gets a remote alert',async t=>{
  const f=fixture(t),one=taskNotifications(f.options);
  one.register(f.who,f.input);
  const scheduledAt=new Date(f.options.now()+1000).toISOString();
  const occurrence={goalId:'g_test',taskId:'t_test',revision:2,scheduledAt};
  one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[occurrence]});
  f.tick(1100);
  one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[]});
  const due=f.item(1,'reminder_due');
  due.payload.notification.scheduled_at=scheduledAt;
  due.payload.snapshot.tasks[0].scheduledAt=scheduledAt;
  f.pages.push(due);
  await one.dispatch();
  assert.equal(f.sent.length,0);
  f.tick(86400_000);
  const tomorrow=f.item(2,'reminder_due');
  tomorrow.payload.notification.scheduled_at=new Date(f.options.now()).toISOString();
  tomorrow.payload.snapshot.tasks[0].previousDailyOccurrence=tomorrow.payload.notification.scheduled_at;
  f.pages.push(tomorrow);
  const next=taskNotifications(f.options);
  await next.dispatch();
  assert.deepEqual(f.sent.map(n=>[n.eventId,n.kind]),[['event:2','reminder_due']]);
});
test('a manual change of time invalidates an offline due notice before retry',async t=>{
  const f=fixture(t);
  let attempts=0;
  const service=taskNotifications({...f.options,send:async()=>{attempts++;throw Error('offline');}});
  service.register(f.who,f.input);
  const due=f.item(1,'reminder_due');
  const oldTime=new Date(f.options.now()).toISOString();
  due.payload.notification.scheduled_at=oldTime;
  due.payload.snapshot.tasks[0].scheduledAt=oldTime;
  f.pages.push(due);
  await service.dispatch();
  assert.equal(attempts,1);
  const changed=f.item(2);
  delete changed.payload.notification;
  changed.payload.snapshot.tasks[0].scheduledAt=new Date(f.options.now()+3600000).toISOString();
  f.pages.push(changed);f.tick(4000);
  await service.dispatch();
  assert.equal(attempts,1);
});

test('a persisted iOS daily repeat receipt covers later local occurrences after Host restart',async t=>{
  const f=fixture(t),one=taskNotifications(f.options);
  one.register(f.who,f.input);
  const firstScheduledAt=new Date(f.options.now()+1000).toISOString();
  one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[{goalId:'g_test',taskId:'t_test',revision:2,
    scheduledAt:firstScheduledAt,firstScheduledAt,repeat:'daily',timezone:'Asia/Shanghai'}]});
  f.tick(3*86400_000+1100);
  const due=f.item(1,'reminder_due');
  due.payload.notification.scheduled_at=new Date(Date.parse(firstScheduledAt)+3*86400_000).toISOString();
  due.payload.snapshot.tasks[0].previousDailyOccurrence=due.payload.notification.scheduled_at;
  f.pages.push(due);
  await taskNotifications(f.options).dispatch();
  assert.equal(f.sent.length,0,'an already repeating system request must not be remotely delivered again');
  const shifted=f.item(2,'reminder_due');
  shifted.payload.notification.scheduled_at=new Date(Date.parse(due.payload.notification.scheduled_at)+60_000).toISOString();
  shifted.payload.snapshot.tasks[0].scheduledAt=shifted.payload.notification.scheduled_at;
  f.pages.push(shifted);
  await taskNotifications(f.options).dispatch();
  assert.deepEqual(f.sent.map(n=>n.eventId),['event:2'],'a changed clock still needs delivery');
});

test('weekly iOS receipts cover only the original weekday and never a prior occurrence',async t=>{
  for(const [firstDays,dueDays,expected] of [[0,7,0],[0,6,1],[7,0,1]]) {
    const f=fixture(t),one=taskNotifications(f.options);one.register(f.who,f.input);
    const origin=f.options.now()+1000,firstScheduledAt=new Date(origin+firstDays*86400_000).toISOString();
    one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[{goalId:'g_test',taskId:'t_test',revision:2,
      scheduledAt:firstScheduledAt,firstScheduledAt,repeat:'weekly',timezone:'Asia/Shanghai',weekday:7}]});
    f.tick(dueDays*86400_000+1100);
    const due=f.item(1,'reminder_due');
    due.payload.notification.scheduled_at=new Date(origin+dueDays*86400_000).toISOString();
    due.payload.snapshot.tasks[0].scheduledAt=due.payload.notification.scheduled_at;f.pages.push(due);
    await taskNotifications(f.options).dispatch();assert.equal(f.sent.length,expected);
  }
});

test('withdrawing a recurring system receipt retains only its last fired occurrence, not future coverage',async t=>{
  const f=fixture(t),one=taskNotifications(f.options);one.register(f.who,f.input);
  const firstScheduledAt=new Date(f.options.now()+1000).toISOString();
  one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[{goalId:'g_test',taskId:'t_test',revision:2,
    scheduledAt:firstScheduledAt,firstScheduledAt,repeat:'daily',timezone:'Asia/Shanghai'}]});
  f.tick(1100);one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[]});
  f.tick(86400_000);
  const due=f.item(1,'reminder_due');due.payload.notification.scheduled_at=new Date(Date.parse(firstScheduledAt)+86400_000).toISOString();
  due.payload.snapshot.tasks[0].scheduledAt=due.payload.notification.scheduled_at;f.pages.push(due);
  await taskNotifications(f.options).dispatch();assert.equal(f.sent.length,1);
});

test('recurring receipts reject invalid timezone, cadence, weekday, anchor and clock combinations',t=>{
  const f=fixture(t),one=taskNotifications(f.options);
  const firstScheduledAt=new Date(f.options.now()+1000).toISOString();
  const row={goalId:'g_test',taskId:'t_test',revision:2,scheduledAt:firstScheduledAt,firstScheduledAt,repeat:'daily',timezone:'Asia/Shanghai'};
  for(const patch of [{timezone:'Mars/Olympus'},{repeat:'monthly'},{weekday:2},{firstScheduledAt:'bad'},
    {firstScheduledAt:new Date(Date.parse(firstScheduledAt)+86400_000).toISOString()},
    {scheduledAt:new Date(Date.parse(firstScheduledAt)+60_000).toISOString()},
    {repeat:'weekly',weekday:1},{repeat:undefined},{timezone:undefined}]) {
    assert.throws(()=>one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[{...row,...patch}]}),/排程/);
  }
});

test('a late first iOS repeat registration cannot claim that an earlier due alert was delivered', async t=>{
  const f=fixture(t),one=taskNotifications(f.options);one.register(f.who,f.input);
  const dueAt=new Date(f.options.now()+1000).toISOString();
  f.tick(31_000); // App syncs for the first time after the due time.
  const nextAt=new Date(Date.parse(dueAt)+86400_000).toISOString();
  one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[{goalId:'g_test',taskId:'t_test',revision:2,
    scheduledAt:nextAt,firstScheduledAt:dueAt,repeat:'daily',timezone:'Asia/Shanghai'}]});
  const due=f.item(1,'reminder_due');due.payload.notification.scheduled_at=dueAt;
  due.payload.snapshot.tasks[0].scheduledAt=dueAt;f.pages.push(due);
  await one.dispatch();
  assert.equal(f.sent.length,1,'the newly installed system request will first fire tomorrow, so today still requires delivery');
});

test('refreshing the next repeat date after a real firing still preserves that fired occurrence',async t=>{
  const f=fixture(t),one=taskNotifications(f.options);one.register(f.who,f.input);
  const dueAt=new Date(f.options.now()+1000).toISOString();
  const row={goalId:'g_test',taskId:'t_test',revision:2,scheduledAt:dueAt,firstScheduledAt:dueAt,repeat:'daily',timezone:'Asia/Shanghai'};
  one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[row]});
  f.tick(31_000);
  one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[{...row,scheduledAt:new Date(Date.parse(dueAt)+86400_000).toISOString()}]});
  const due=f.item(1,'reminder_due');due.payload.notification.scheduled_at=dueAt;
  due.payload.snapshot.tasks[0].scheduledAt=dueAt;f.pages.push(due);
  await one.dispatch();assert.equal(f.sent.length,0);
});

test('a repeat receipt covers a changed UTC offset while preserving local clock after daylight saving begins',async t=>{
  const f=fixture(t),one=taskNotifications(f.options);one.register(f.who,f.input);
  const before='2027-03-13T07:30:00.000Z',after='2027-03-15T06:30:00.000Z';
  one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[{goalId:'g_test',taskId:'t_test',revision:2,
    scheduledAt:before,firstScheduledAt:before,repeat:'daily',timezone:'America/New_York'}]});
  f.tick(Date.parse(after)-f.options.now()+100);
  const due=f.item(1,'reminder_due');due.payload.notification.scheduled_at=after;
  due.payload.snapshot.tasks[0].scheduledAt=after;f.pages.push(due);
  await taskNotifications(f.options).dispatch();assert.equal(f.sent.length,0);
});


test('the later clock occurrence during a daylight saving fold is not covered by an earlier recurring alert',async t=>{
  const f=fixture(t),one=taskNotifications(f.options);one.register(f.who,f.input);
  const firstScheduledAt='2027-11-06T05:30:00.000Z',later='2027-11-07T06:30:00.000Z';
  one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[{goalId:'g_test',taskId:'t_test',revision:2,
    scheduledAt:firstScheduledAt,firstScheduledAt,repeat:'daily',timezone:'America/New_York'}]});
  f.tick(Date.parse(later)-f.options.now()+100);
  const due=f.item(1,'reminder_due');due.payload.notification.scheduled_at=later;
  due.payload.snapshot.tasks[0].scheduledAt=later;f.pages.push(due);
  await taskNotifications(f.options).dispatch();assert.equal(f.sent.length,1);
});

test('the Host accepts a real civil recurrence whose next occurrence shifted through a DST gap',t=>{
  const f=fixture(t),one=taskNotifications(f.options);
  const receipt={goalId:'g_test',taskId:'t_test',revision:2,repeat:'daily',timezone:'America/New_York',
    firstScheduledAt:'2027-03-13T07:30:00Z',wallTime:'2027-03-13T07:30:00Z',scheduledAt:'2027-03-14T07:30:00Z'};
  assert.doesNotThrow(()=>one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[receipt]}));
});


test('system second precision matches Agent timestamps with fractional milliseconds',async t=>{
  const f=fixture(t),one=taskNotifications(f.options);one.register(f.who,f.input);
  const firstScheduledAt=new Date(f.options.now()+1523).toISOString(),actual=new Date(f.options.now()+1000).toISOString();
  assert.doesNotThrow(()=>one.scheduled(f.who,{expectedUserId:f.who.userId,reminders:[{goalId:'g_test',taskId:'t_test',revision:2,
    scheduledAt:actual,firstScheduledAt,repeat:'daily',timezone:'Asia/Shanghai'}]}));
  f.tick(2100);
  const due=f.item(1,'reminder_due');due.payload.notification.scheduled_at=firstScheduledAt;
  due.payload.snapshot.tasks[0].scheduledAt=firstScheduledAt;f.pages.push(due);
  await one.dispatch();assert.equal(f.sent.length,0);
});


test('classification-only history never becomes a new Host alert and still advances its scan cursor',async t=>{
  const f=fixture(t),service=taskNotifications(f.options);service.register(f.who,f.input);
  const classified=f.item(1);classified.payload.classification_only=true;
  f.pages.push(classified,f.item(2));await service.dispatch();
  assert.deepEqual(f.sent.map(r=>r.eventId),['event:2']);
  await taskNotifications(f.options).dispatch();assert.equal(f.sent.length,1);
});

test('finished Agent results notify only for the exact current result evidence and stay suppressed after cancellation',async t=>{
 const f=fixture(t),service=taskNotifications(f.options);service.register(f.who,f.input);
 const result=(seq,kind='task_result')=>{
  const item=f.item(seq,kind),task=item.payload.snapshot.tasks[0];task.status='done';
  if(kind==='task_result'){
   item.payload.calculation_receipt_id='calc_'+'c'.repeat(40);
   task.execution={version:1,count:1,records:[{kind:'calculation',outcome:'calculated',calculationReceiptId:item.payload.calculation_receipt_id}]};
  }else{
   item.payload.recommendation={version:1,sources:[{id:'same_task_source'}]};
   task.execution={version:1,count:1,records:[{kind:'research',outcome:'researched',recommendationEventId:item.payload.notification.event_id}]};
  }
  return item;
 };
 const good=result(1),research=result(2,'recommendation_ready'),missing=result(3),old=result(4),wrong=result(5),cancelled=result(6);
 delete missing.payload.calculation_receipt_id;old.payload.notification.revision=1;wrong.payload.snapshot.tasks[0].execution.records[0].calculationReceiptId='calc_'+'d'.repeat(40);cancelled.payload.snapshot.tasks[0].status='cancelled';
 // Separate goals prevent one synthetic snapshot from intentionally superseding another route.
 for(const item of [good,research,missing,old,wrong,cancelled]){const goalId='g_result_'+item.seq;item.goalId=goalId;item.payload.snapshot.goal.id=goalId;item.payload.snapshot.tasks[0].goalId=goalId;}
 f.pages.push(good,research,missing,old,wrong,cancelled);await service.dispatch();
 assert.deepEqual(f.sent.map(r=>r.eventId),['event:1','event:2']);
});
