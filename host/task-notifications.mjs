import {readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {HostError} from './host-error.mjs';

const recent=10*60_000;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const same=(a,b)=>a?.userId===b?.userId&&a?.deviceId===b?.deviceId;
function routeFor(item,who) {
  const note=item.payload?.notification,detail=item.payload?.snapshot;
  if (!note||!['recommendation_ready','task_result'].includes(note.kind)||typeof note.event_id!=='string'||
      !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,179}$/.test(note.event_id)||!Number.isSafeInteger(note.revision)||note.revision<0||
      item.userId!==who.userId||!id(item.goalId)||detail?.goal?.id!==item.goalId||detail.goal.status!=='active') return null;
  if (item.taskId!==undefined) {
    const task=detail.tasks?.find(t=>t.id===item.taskId&&t.goalId===item.goalId);
    if (!id(item.taskId)||!task||task.status==='cancelled'||(note.kind==='recommendation_ready'&&task.status!=='open')) return null;
  }
  return {userId:who.userId,goalId:item.goalId,...(item.taskId?{taskId:item.taskId}:{}),
    eventId:note.event_id,revision:note.revision,kind:note.kind};
}

// A private cursor reads the same durable outbox without acknowledging or advancing the phone's cursor.
export function taskNotifications({dir,identity,readPage,send,now=Date.now}) {
  const file=join(dir,'notification-device.json');
  let state=null,busy=false,nextTry=0,failures=0;
  try {state=JSON.parse(readFileSync(file,'utf8'));} catch (error) {
    if (error.code!=='ENOENT') console.warn('Along 远程通知登记需重新建立');
  }
  function save(updated) {
    const temp=file+'.tmp';
    writeFileSync(temp,JSON.stringify(updated),{mode:0o600});
    renameSync(temp,file);
    state=updated;
  }
  function active(who) {return Boolean(who&&same(who,state)&&same(who,identity())&&state?.token&&send);}
  function register(who,input) {
    if (!same(who,identity())||input?.expectedUserId!==who.userId) throw new HostError('通知绑定已变更',409);
    const previous=same(who,state)?state:null;
    if (input.enabled===false) {
      if (previous?.token) save({...previous,token:null});
    } else {
      if (typeof input.token!=='string'||input.token.length<2||input.token.length>1024||
          !/^(?:[0-9a-f]{2})+$/i.test(input.token)||!['development','production'].includes(input.environment))
        throw new HostError('通知设备登记格式不正确',400);
      if (send&&(input.token!==previous?.token||input.environment!==previous?.environment)) {
        save({...who,cursor:previous?.cursor??0,seen:previous?.seen??[],enabledAt:previous?.token?previous.enabledAt:now(),
          token:input.token,environment:input.environment});
        nextTry=0;
      }
    }
    return {userId:who.userId,remoteNotifications:active(who)};
  }
  function owns(who,item) {
    if (!who||!same(who,state)||!same(who,identity())) return false;
    const note=item.payload?.notification;
    if (!note) return false;
    if (state.seen.some(entry=>entry.id===note.event_id)) return true;
    return active(who)&&Date.parse(item.createdAt)>=state.enabledAt;
  }
  function decorate(who,page) {
    return {...page,remoteNotifications:active(who),items:page.items.map(item=>
      item.payload?.notification?{...item,remoteNotifications:owns(who,item)}:item)};
  }
  async function dispatch() {
    const who=identity();
    if (!active(who)||busy||now()<nextTry) return;
    busy=true;
    try {
      const initial=state;
      const page=await readPage(who,initial.cursor,100);
      if (initial!==state||!active(who)) return;
      let cursor=state.cursor;
      for (const item of page.items) {
        if (!Number.isSafeInteger(item.seq)||item.seq<=cursor||item.userId!==who.userId) throw Error('通知同步记录无效');
        const expires=Date.parse(item.createdAt)+recent;
        const route=routeFor(item,who);
        if (route&&Number.isFinite(expires)&&expires>now()&&owns(who,item)&&!state.seen.some(entry=>entry.id===route.eventId)) {
          const registered=state;
          const result=await send(registered,route,expires);
          if (registered!==state||!active(who)) return;
          if (result==='invalid_device') {save({...state,token:null});return;}
          if (result!=='accepted') throw Error('尚未收到 APNs 回执');
          save({...state,cursor:item.seq,seen:[...state.seen.filter(entry=>entry.expires>now()),{id:route.eventId,expires}]});
        }
        cursor=item.seq;
      }
      if (state.cursor!==cursor) save({...state,cursor,seen:state.seen.filter(entry=>entry.expires>now())});
      failures=0;nextTry=0;
    } catch {
      nextTry=now()+Math.min(60_000,2000*2**Math.min(failures++,5));
    } finally {busy=false;}
  }
  return {active,register,decorate,dispatch};
}
