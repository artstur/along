import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeviceSourceRoute,deviceAwareSourceConnection} from '../host/device-source-routes.mjs';
import {DeviceSourceError} from '../host/device-source-gateway.mjs';
const userId='u_fixture',deviceId='d_fixture',goalId='g_fixture';
const goal=()=>({goal:{id:goalId,userId,status:'active',currentRevision:1},revision:{goalId,userId,status:'active',revision:1},dataSources:[{provider:'okx',status:'recommended'}]});
test('device ingress binds server identity, rechecks ownership and retires legacy only after scope takeover',async()=>{
  // 每请求身份（M2）：绑定由宿主按请求解析传入；stillBound 复查该绑定仍在绑定表中，
  // 重配对整条替换绑定后旧守卫立即失效。
  const who={userId,deviceId};
  let pairings=[{user_id:userId,device_id:deviceId}],owned=false,retired=false;const calls=[];
  const stillBound=w=>pairings.some(entry=>entry.user_id===w.userId&&entry.device_id===w.deviceId);
  const route=createDeviceSourceRoute({stillBound,readGoal:async()=>goal(),gateway:{handle:async args=>{
    calls.push(args);assert.equal(await args.stillAuthorized(),true);owned=true;return {grantId:'opaque'};
  }},retireLegacy:async()=>{assert.equal(owned,true);retired=true;}});
  for(const field of ['userId','deviceId','user_id','device_id'])await assert.rejects(route({action:'open',provider:'okx',goalId,[field]:'forged'},who));
  await route({action:'open',provider:'okx',goalId,requestId:'open_one',expectedGrantId:null},who);
  assert.equal(retired,true);assert.equal(calls[0].userId,userId);assert.equal(calls[0].deviceId,deviceId);
  const gate=calls[0].stillAuthorized;pairings=[];assert.equal(await gate(),false,'绑定不在表中（已重配对）时旧守卫失效');
});
test('permanent device failures match the event; temporary storage failures remain retryable',async()=>{
  const who={userId,deviceId};let error=new DeviceSourceError('event_conflict');
  const route=createDeviceSourceRoute({stillBound:()=>true,readGoal:async()=>goal(),gateway:{handle:async()=>{throw error;}}});
  const input={action:'publish',provider:'okx',goalId,eventId:'event_one'};
  assert.deepEqual(await route(input,who),{status:409,value:{event_id:'event_one',status:'conflict',reason:'event_conflict'}});
  error=new DeviceSourceError('storage_unavailable');await assert.rejects(route(input,who),e=>e.status===503);
});
test('device-owned pending and disconnected scopes cannot fall back to old Mac credentials',async()=>{
  const who={userId,deviceId};let owned=true;let legacyReads=0;const seen=[];
  // binding(userId) 解析该用户现役绑定：本用户的请求拿到绑定，别的 userId 直接无绑定。
  const facade=deviceAwareSourceConnection({binding:id=>id===who.userId?who:null,gateway:{hasScope:()=>owned,owned:()=>true,sourceSnapshot:async args=>{seen.push(args);return null;},handle:async args=>{seen.push(args);return {state:'disconnected'};}},legacy:{sourceSnapshot:async()=>{legacyReads++;return {old:true};},handle:async()=>{legacyReads++;}}});
  assert.equal(await facade.sourceSnapshot({userId,goalId}),null);assert.equal(legacyReads,0);assert.equal(seen[0].deviceId,deviceId);
  await facade.handle({userId,goalId,input:{action:'disconnect'},sourceState:'revoked'});
  assert.equal(seen[1].sourceState,'revoked');assert.equal(seen[1].deviceId,undefined);
  owned=false;assert.deepEqual(await facade.sourceSnapshot({userId,goalId}),{old:true});
  assert.throws(()=>facade.sourceSnapshot({userId:'u_other',goalId}));
});
