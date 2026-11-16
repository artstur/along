import {readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {HostError} from './host-error.mjs';

const lifetime=10*60_000;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const eventId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,179}$/.test(value);
const same=(a,b)=>a?.userId===b?.userId&&a?.deviceId===b?.deviceId;
const sameOccurrence=(a,b)=>a.goalId===b.goalId&&a.taskId===b.taskId&&Date.parse(a.scheduledAt)===Date.parse(b.scheduledAt);

function relevant(route,detail) {
  if (detail?.goal?.id!==route.goalId||detail.goal.status!=='active') return false;
  const task=route.taskId&&detail.tasks?.find(t=>t.id===route.taskId&&t.goalId===route.goalId);
  if (route.taskId&&(!task||task.status==='cancelled')) return false;
  if (route.kind==='reminder_due') return task?.status==='open';
  if (route.kind!=='recommendation_ready') return true;
  return (!task||task.status==='open')&&(task||detail.goal).currentRevision===route.revision;
}
function notification(item,who) {
  const n=item.payload?.notification;
  if (!n||!['recommendation_ready','task_result','reminder_due'].includes(n.kind)||!eventId(n.event_id)||
      !Number.isSafeInteger(n.revision)||n.revision<0||item.userId!==who.userId||!id(item.goalId)||
      (item.taskId!==undefined&&!id(item.taskId))) return null;
  let scheduledAt;
  if (n.kind==='reminder_due') {
    if (!item.taskId||!Number.isFinite(Date.parse(n.scheduled_at))) return null;
    scheduledAt=n.scheduled_at;
  }
  const route={userId:who.userId,goalId:item.goalId,...(item.taskId?{taskId:item.taskId}:{}),
    eventId:n.event_id,revision:n.revision,kind:n.kind,...(scheduledAt?{scheduledAt}:{})};
  return relevant(route,item.payload.snapshot)?route:null;
}

// Read the Agent outbox without acknowledging the phone's cursor. Store only routing metadata.
export function taskNotifications({dir,identity,readPage,send,now=Date.now}) {
  const file=join(dir,'notification-device.json');
  let state=null,busy=false,inFlight=null,afterFailure=0;
  try {state=JSON.parse(readFileSync(file,'utf8'));} catch (error) {
    if (error.code!=='ENOENT') console.warn('Along 远程通知登记需重新建立');
  }
  function save(updated) {
    const temp=file+'.tmp';
    writeFileSync(temp,JSON.stringify(updated),{mode:0o600});
    renameSync(temp,file);
    state=updated;
  }
  const start=who=>({...who,token:null,cursor:0,enabledAt:0,seen:[],queue:[],scheduled:[]});
  const active=who=>Boolean(who&&same(who,state)&&same(who,identity())&&state?.token&&send);
  function checkBinding(who,input) {
    if (!same(who,identity())||input?.expectedUserId!==who.userId) throw new HostError('通知绑定已变更',409);
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
      !id(r.taskId)||!Number.isSafeInteger(r.revision)||r.revision<0||!Number.isFinite(Date.parse(r.scheduledAt))))
      throw new HostError('系统排程回执格式不正确',400);
    const previous=same(who,state)?state:start(who);
    // A request disappears from pending when it fires. Retain that occurrence through the remote retry window.
    const justFired=previous.scheduled.filter(r=>Date.parse(r.scheduledAt)<=now()&&Date.parse(r.scheduledAt)+lifetime>now());
    const rows=input.reminders.map(({goalId,taskId,revision,scheduledAt})=>({goalId,taskId,revision,scheduledAt}));
    const next=[...justFired.filter(r=>!rows.some(n=>sameOccurrence(r,n))),...rows];
    if (JSON.stringify(next)!==JSON.stringify(previous.scheduled)) save({...previous,scheduled:next});
    return {userId:who.userId,accepted:rows.length};
  }
  function owns(who,item) {
    if (!who||!same(who,state)||!same(who,identity())) return false;
    const n=item.payload?.notification;
    if (!n) return false;
    return state.seen.some(s=>s.id===n.event_id)||state.queue.some(q=>q.route.eventId===n.event_id)||
      (active(who)&&Date.parse(item.createdAt)>=state.enabledAt);
  }
  function decorate(who,page,input={}) {
    let fallback=[];
    if (input.notificationFallback===true&&same(who,state)&&same(who,identity())) {
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
    const who=identity();
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
        if (q.route.kind==='reminder_due'&&state.scheduled.some(r=>sameOccurrence(r,q.route))) {settle(q,'local_schedule');continue;}
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
