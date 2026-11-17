import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeviceSourceRoute,deviceAwareSourceConnection} from '../host/device-source-routes.mjs';
import {DeviceSourceError} from '../host/device-source-gateway.mjs';
const userId='u_fixture',deviceId='d_fixture',goalId='g_fixture';
const goal=()=>({goal:{id:goalId,userId,status:'active',currentRevision:1},revision:{goalId,userId,status:'active',revision:1},dataSources:[{provider:'okx',status:'recommended'}]});
test('device ingress binds server identity, rechecks ownership and retires legacy only after scope takeover',async()=>{
  let who={userId,deviceId},owned=false,retired=false;const calls=[];
  const route=createDeviceSourceRoute({identity:()=>who,readGoal:async()=>goal(),gateway:{handle:async args=>{
    calls.push(args);assert.equal(await args.stillAuthorized(),true);owned=true;return {grantId:'opaque'};
  }},retireLegacy:async()=>{assert.equal(owned,true);retired=true;}});
  for(const field of ['userId','deviceId','user_id','device_id'])await assert.rejects(route({action:'open',provider:'okx',goalId,[field]:'forged'}));
  await route({action:'open',provider:'okx',goalId,requestId:'open_one'});
  assert.equal(retired,true);assert.equal(calls[0].userId,userId);assert.equal(calls[0].deviceId,deviceId);
  const gate=calls[0].stillAuthorized;who={...who};assert.equal(await gate(),false);
});
test('permanent device failures match the event; temporary storage failures remain retryable',async()=>{
  const who={userId,deviceId};let error=new DeviceSourceError('event_conflict');
  const route=createDeviceSourceRoute({identity:()=>who,readGoal:async()=>goal(),gateway:{handle:async()=>{throw error;}}});
  const input={action:'publish',provider:'okx',goalId,eventId:'event_one'};
  assert.deepEqual(await route(input),{status:409,value:{event_id:'event_one',status:'conflict',reason:'event_conflict'}});
  error=new DeviceSourceError('storage_unavailable');await assert.rejects(route(input),e=>e.status===503);
});
test('device-owned pending and disconnected scopes cannot fall back to old Mac credentials',async()=>{
  const who={userId,deviceId};let owned=true;let legacyReads=0;const seen=[];
  const facade=deviceAwareSourceConnection({identity:()=>who,gateway:{hasScope:()=>owned,owned:()=>true,sourceSnapshot:async args=>{seen.push(args);return null;},handle:async args=>{seen.push(args);return {state:'disconnected'};}},legacy:{sourceSnapshot:async()=>{legacyReads++;return {old:true};},handle:async()=>{legacyReads++;}}});
  assert.equal(await facade.sourceSnapshot({userId,goalId}),null);assert.equal(legacyReads,0);assert.equal(seen[0].deviceId,deviceId);
  await facade.handle({userId,goalId,input:{action:'disconnect'},sourceState:'revoked'});
  assert.equal(seen[1].sourceState,'revoked');assert.equal(seen[1].deviceId,undefined);
  owned=false;assert.deepEqual(await facade.sourceSnapshot({userId,goalId}),{old:true});
  assert.throws(()=>facade.sourceSnapshot({userId:'u_other',goalId}));
});
