import {readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {HostError} from './host-error.mjs';
import {taskResultRelevant,resultEvidence} from '../web/task-results.mjs';

const lifetime=10*60_000;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const eventId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,179}$/.test(value);
const same=(a,b)=>a?.userId===b?.userId&&a?.deviceId===b?.deviceId;
const systemSecond=value=>Math.floor(Date.parse(value)/1000)*1000;
const sameOccurrence=(a,b)=>a.goalId===b.goalId&&a.taskId===b.taskId&&systemSecond(a.scheduledAt)===systemSecond(b.scheduledAt);
function civil(at,timezone) {
  const fields=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hourCycle:'h23',
    year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(new Date(at)).map(p=>[p.type,p.value]));
  return {stamp:Date.UTC(+fields.year,+fields.month-1,+fields.day,+fields.hour,+fields.minute,+fields.second),clock:fields.hour+':'+fields.minute+':'+fields.second,weekday:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(fields.weekday)+1};
}
// Match the scheduler's civil-time policy: shift through a gap; choose the first instant in a fold.
function recurringInstant(at,row) {
  const day=86400_000,local=civil(at,row.timezone),anchor=civil(row.wallTime??row.firstScheduledAt,row.timezone);
  if (row.repeat==='weekly'&&local.weekday!==row.weekday) return undefined;
  const target=Math.floor(local.stamp/day)*day+anchor.stamp%day;
  const offsets=[-day,day].map(delta=>civil(target+delta,row.timezone).stamp-(target+delta));
  return [...new Set(offsets)].map(offset=>target-offset).filter(t=>civil(t,row.timezone).stamp>=target)
    .sort((a,b)=>civil(a,row.timezone).stamp-civil(b,row.timezone).stamp||a-b)[0];
}
const instant=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(value)&&Number.isFinite(Date.parse(value));
function validRecurrence(row) {
  const has=['repeat','timezone','weekday','firstScheduledAt','wallTime'].some(k=>row[k]!==undefined);
  if (!has) return true;
  if (!['daily','weekly'].includes(row.repeat)||typeof row.timezone!=='string'||row.timezone.length>100||
      !instant(row.firstScheduledAt)||!instant(row.scheduledAt)||systemSecond(row.firstScheduledAt)>systemSecond(row.scheduledAt)||
      (row.wallTime!==undefined&&!instant(row.wallTime))||
      (row.repeat==='weekly'? !Number.isInteger(row.weekday)||row.weekday<1||row.weekday>7:row.weekday!==undefined)) return false;
  try {
    return recurringInstant(row.scheduledAt,row)===systemSecond(row.scheduledAt);
  } catch {return false;}
}
function coversOccurrence(receipt,route) {
  if (sameOccurrence(receipt,route)) return true;
  if (!receipt.repeat||receipt.goalId!==route.goalId||receipt.taskId!==route.taskId||
      Date.parse(route.scheduledAt)<Date.parse(receipt.scheduledAt)) return false;
  return recurringInstant(route.scheduledAt,receipt)===systemSecond(route.scheduledAt);
}

function relevant(route,detail) {
  if (detail?.goal?.id!==route.goalId||detail.goal.status!=='active') return false;
  const task=route.taskId&&detail.tasks?.find(t=>t.id===route.taskId&&t.goalId===route.goalId);
  if (route.taskId&&(!task||task.status==='cancelled')) return false;
  if (route.kind==='reminder_due') return task?.status==='open'&&
    [task.scheduledAt,task.previousDailyOccurrence].some(at=>Date.parse(at)===Date.parse(route.scheduledAt));
  return taskResultRelevant(route,detail.goal,task);
}
function notification(item,who) {
  const n=item.payload?.notification;
  if (item.payload?.classification_only===true||!n||!['recommendation_ready','task_result','reminder_due'].includes(n.kind)||!eventId(n.event_id)||
      !Number.isSafeInteger(n.revision)||n.revision<0||item.userId!==who.userId||!id(item.goalId)||
      (item.taskId!==undefined&&!id(item.taskId))) return null;
  let scheduledAt;
  if (n.kind==='reminder_due') {
    if (!item.taskId||!Number.isFinite(Date.parse(n.scheduled_at))) return null;
    scheduledAt=n.scheduled_at;
  }
  const route={userId:who.userId,goalId:item.goalId,...(item.taskId?{taskId:item.taskId}:{}),
    eventId:n.event_id,revision:n.revision,kind:n.kind,...(scheduledAt?{scheduledAt}:{}),
    ...(resultEvidence(item.payload)?{evidence:resultEvidence(item.payload)}:{})};
  return relevant(route,item.payload.snapshot)?route:null;
}

// Read the Agent outbox without acknowledging the phone's cursor. Store only routing metadata.
// 每用户一份登记（docs/cloud-deploy-multi-user.md §3.2 M2）：notification-device.<userId>.json，
// 互不覆盖。binding() 解析该用户在绑定表中的现役绑定；stillBound(who) 复查请求捕获的绑定
// 是否仍是现役绑定（同一用户重新配对会整条替换绑定，旧 device 的守卫随即失效）。
export function taskNotifications({dir,userId,binding,readPage,send,now=Date.now,migrateLegacy=false}) {
  if (!id(userId)) throw Error('通知登记用户无效');
  const file=join(dir,`notification-device.${userId}.json`);
  let state=null,busy=false,inFlight=null,afterFailure=0;
  function save(updated) {
    const temp=file+'.tmp';
    writeFileSync(temp,JSON.stringify(updated),{mode:0o600});
    renameSync(temp,file);
    state=updated;
  }
  function restore() {
    try {state=JSON.parse(readFileSync(file,'utf8'));return;}
    catch (error) {
      if (error.code!=='ENOENT') {console.warn('Along 远程通知登记需重新建立');return;}
    }
    const who=migrateLegacy?binding():null;
    if (!who||who.userId!==userId) return;
    const legacy=join(dir,'notification-device.json');
    try {
      const saved=JSON.parse(readFileSync(legacy,'utf8'));
      if (!same(who,saved)) return;
      save(saved);
      unlinkSync(legacy);
    } catch (error) {
      if (error.code!=='ENOENT') console.warn('Along 未能迁移旧版远程通知登记');
    }
  }
  restore();
  const start=who=>({...who,token:null,cursor:0,enabledAt:0,seen:[],queue:[],scheduled:[]});
  const stillBound=who=>{const current=binding();return Boolean(who&&current&&same(who,current));};
  const active=who=>Boolean(who&&same(who,state)&&stillBound(who)&&state?.token&&send);
  function checkBinding(who,input) {
    if (!stillBound(who)||input?.expectedUserId!==who.userId) throw new HostError('通知绑定已变更',409);
  }
  function register(who,input) {
    checkBinding(who,input);
    const previous=same(who,state)?state:start(who);
    if (input.enabled===false) {
      if (previous.token||previous.queue.length) save({...previous,token:null,queue:[],scheduled:[]});
    } else {
      if (typeof input.token!=='string'||input.token.length<2||input.token.length>1024||
          !/^(?:[0-9a-f]{2})+$/i.test(input.token)||!['development','production'].includes(input.environment))
        throw new HostError('通知设备登记格式不正确',400);
      if (send&&(input.token!==previous.token||input.environment!==previous.environment)) {
        save({...previous,enabledAt:previous.token?previous.enabledAt:now(),token:input.token,environment:input.environment});
        afterFailure=0;
      }
    }
    return {userId:who.userId,remoteNotifications:active(who)};
  }
  function scheduled(who,input) {
    checkBinding(who,input);
    if (!Array.isArray(input.reminders)||input.reminders.length>64||input.reminders.some(r=>!r||!id(r.goalId)||
      !id(r.taskId)||!Number.isSafeInteger(r.revision)||r.revision<0||!Number.isFinite(Date.parse(r.scheduledAt))||!validRecurrence(r)))
      throw new HostError('系统排程回执格式不正确',400);
    const previous=same(who,state)?state:start(who);
    // A request disappears from pending when it fires. Retain that occurrence through the remote retry window.
    const justFired=previous.scheduled.filter(r=>Date.parse(r.scheduledAt)<=now()&&Date.parse(r.scheduledAt)+lifetime>now())
      .map(({goalId,taskId,revision,scheduledAt})=>({goalId,taskId,revision,scheduledAt}));
    const rows=input.reminders.map(({goalId,taskId,revision,scheduledAt,repeat,timezone,weekday,firstScheduledAt,wallTime})=>
      ({goalId,taskId,revision,scheduledAt,...(repeat?{repeat,timezone,firstScheduledAt,...(weekday?{weekday}:{}),...(wallTime?{wallTime}:{})}:{})}));
    const next=[...justFired.filter(r=>!rows.some(n=>sameOccurrence(r,n))),...rows];
    if (JSON.stringify(next)!==JSON.stringify(previous.scheduled)) save({...previous,scheduled:next});
    return {userId:who.userId,accepted:rows.length};
  }
  function owns(who,item) {
    if (!who||!same(who,state)||!stillBound(who)) return false;
    const n=item.payload?.notification;
    if (!n) return false;
    return state.seen.some(s=>s.id===n.event_id)||state.queue.some(q=>q.route.eventId===n.event_id)||
      (active(who)&&Date.parse(item.createdAt)>=state.enabledAt);
  }
  function decorate(who,page,input={}) {
    let fallback=[];
    if (input.notificationFallback===true&&same(who,state)&&stillBound(who)) {
      const ids=input.notificationReceipts??[];
      if (!Array.isArray(ids)||ids.length>50||!ids.every(eventId)) throw new HostError('通知回执格式不正确',400);
      const seen=state.seen.filter(s=>s.expires>now());
      const queue=[];
      for (const old of state.queue) {
        if (old.expires<=now()) continue;
        if (old.local&&ids.includes(old.route.eventId)) {seen.push({id:old.route.eventId,expires:old.expires});continue;}
        // A failed provider attempt can hand off to the native foreground channel. Once claimed, the Host never sends it again.
        const claim=old.route.kind!=='reminder_due'&&old.route.eventId!==inFlight&&(old.attempts>0||!active(who));
        const q=claim&&!old.local&&fallback.length<50?{...old,local:true}:old;
        queue.push(q);
        if (q.local&&fallback.length<50) fallback.push({...q.route,createdAt:q.createdAt});
      }
      if (queue.length!==state.queue.length||seen.length!==state.seen.length||queue.some((q,i)=>q!==state.queue[i]))
        save({...state,queue,seen});
    }
    return {...page,remoteNotifications:active(who),...(input.notificationFallback?{notificationFallback:fallback}:{}),
      items:page.items.map(item=>item.payload?.notification?{...item,remoteNotifications:owns(who,item)}:item)};
  }
  function ingest(page,who) {
    let {cursor}=state;
    let queue=state.queue.filter(q=>q.expires>now());
    const seen=state.seen.filter(s=>s.expires>now());
    for (const item of page.items) {
      if (!Number.isSafeInteger(item.seq)||item.seq<=cursor||item.userId!==who.userId) throw Error('通知同步记录无效');
      cursor=item.seq;
      const detail=item.payload?.snapshot;
      if (detail?.goal?.id===item.goalId&&item.goalId) queue=queue.filter(q=>q.route.goalId!==item.goalId||relevant(q.route,detail));
      const route=notification(item,who);
      if (!route||Date.parse(item.createdAt)<state.enabledAt) continue;
      const expires=Date.parse(route.scheduledAt??item.createdAt)+lifetime;
      if (!Number.isFinite(expires)||expires<=now()||seen.some(s=>s.id===route.eventId)||queue.some(q=>q.route.eventId===route.eventId)) continue;
      queue.push({route,createdAt:item.createdAt,expires,attempts:0,retryAt:0,local:false});
    }
    if (state.cursor!==cursor||queue.length!==state.queue.length||seen.length!==state.seen.length) save({...state,cursor,queue,seen});
  }
  function settle(q,result) {
    const queue=state.queue.filter(entry=>entry!==q);
    if (result==='accepted'||result==='local_schedule') {
      save({...state,queue,seen:[...state.seen,{id:q.route.eventId,expires:q.expires}]});
    } else {
      const retryAt=now()+Math.min(60_000,2000*2**Math.min(q.attempts,5));
      queue.push({...q,attempts:q.attempts+1,retryAt});
      save({...state,queue,...(result==='invalid_device'?{token:null}:{})});
    }
  }
  async function dispatch() {
    const who=binding();
    if (!active(who)||busy||now()<afterFailure) return;
    busy=true;
    try {
      const cursor=state.cursor,token=state.token;
      const page=await readPage(who,cursor,100);
      if (!active(who)||state.cursor!==cursor||state.token!==token) return;
      ingest(page,who);
      if (page.nextCursor!==undefined) return; // Catch up with cancellations and newer revisions first.
      for (const q of [...state.queue]) {
        if (!active(who)||!state.queue.includes(q)||q.local||q.retryAt>now()||q.expires<=now()) continue;
        if (q.route.kind==='reminder_due'&&state.scheduled.some(r=>coversOccurrence(r,q.route))) {settle(q,'local_schedule');continue;}
        inFlight=q.route.eventId;
        let result;
        try {result=await send(state,q.route,q.expires);} catch {result='retry';}
        inFlight=null;
        if (!active(who)||state.token!==token||!state.queue.includes(q)) return;
        settle(q,result);
      }
    } catch {afterFailure=now()+3000;} finally {busy=false;inFlight=null;}
  }
  return {active,register,scheduled,decorate,dispatch};
}
