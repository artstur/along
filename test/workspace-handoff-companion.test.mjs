import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalHandoffJSON,handoffDigest,expectedHandoffHolds,writePrivateHandoffJSON} from '../host/workspace-handoff.mjs';
import {validateHostCompanion,stagedHostCompanion,installHostCompanion,exportHostCompanion} from '../host/workspace-handoff-companion.mjs';
import {savePairings} from '../host/pairing.mjs';
const digest=x=>handoffDigest(canonicalHandoffJSON(x)),u='u_12345678',d='d_12345678',g='g_original',key=handoffDigest(JSON.stringify([u,g,'okx']));
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 const value={format:'along-host-personal-handoff/v1',sourceUserId:u,sourceDeviceId:d,sourceCredentialSHA256:'1'.repeat(64),goalIds:[g],daily:[],
  notificationLedger:{userId:u,deviceId:d,token:null,cursor:0,enabledAt:0,seen:[],queue:[],scheduled:[
   {goalId:g,taskId:'t_yoga',revision:1,scheduledAt:'2099-01-01T10:00:00Z'}]},
  sourceJournal:{version:1,deliveries:{['2'.repeat(64)]:'3'.repeat(64)},sources:{[key]:{userId:u,goalId:g,provider:'okx',generation:2,revision:4,
   current:{generation:2,revision:4,reference:'src_original',occurredAt:'2026-11-24T04:00:00Z',state:'ready',connectionId:'original_connection',producerVersion:7,
    digest:'4'.repeat(64),capabilities:['trading_account_summary','trading_history']},pending:null,outbox:[],producerVersions:{original_connection:7},retired:['retired_connection']}}}};
 const manifest={format:'along-personal-handoff/v1',migrationId:'handoff-synthetic-0001',sourceUserId:u,sourceDeviceId:d,targetOrigin:'https://cloud.example.com',
  schemaVersion:18,createdAt:'2026-11-24T05:00:00Z',goalIds:[g],snapshotSHA256:'5'.repeat(64),syncPrefixSHA256:'6'.repeat(64),syncHighWaterMark:117,
  activationPermitSHA256:'7'.repeat(64),hostCompanionSHA256:digest(value),sourceHolds:[{provider:'okx',goalId:g,reason:'cloud_history_unsupported',sourceEventId:'evt_history',sourceGeneration:2,sourceRevision:4}],tables:[]};
 const targetReceipt={snapshotSHA256:'8'.repeat(64),syncHighWaterMark:118,sourceHolds:expectedHandoffHolds(manifest)};
 return {value,manifest,targetReceipt};
}
test('cold Host companion retains reminder ledger and dedup/producer state but history becomes an exact unavailable hold',()=>{
 const {value,manifest,targetReceipt}=fixture(),before=clone(value),next=stagedHostCompanion(value,manifest,targetReceipt);
 assert.deepEqual(value,before,'original state not modified');assert.deepEqual(next.notificationLedger,value.notificationLedger);
 assert.deepEqual(next.journal.deliveries,value.sourceJournal.deliveries);
 const row=next.journal.sources[key];assert.deepEqual(row.producerVersions,value.sourceJournal.sources[key].producerVersions);assert.deepEqual(row.retired,value.sourceJournal.sources[key].retired);
 assert.equal(row.current.state,'unavailable');assert.equal(row.current.generation,2);assert.equal(row.current.revision,5);
 assert.equal(row.current.reference,'handoff:handoff-synthetic-0001:cloud_history_unsupported');assert.equal(row.current.occurredAt,manifest.createdAt);
 assert.equal(row.current.digest,undefined);assert.equal(row.current.capabilities,undefined);assert.deepEqual(row.outbox,[]);
});
test('unknown ownership, unsettled journal, remote token, daily grants and wrong manifested generation are refused',()=>{
 const {value,manifest,targetReceipt}=fixture();
 const variants=[v=>v.sourceJournal.sources[key].pending={},v=>v.sourceJournal.sources[key].outbox=[{}],v=>v.sourceJournal.sources[key].userId='u_aaaaaaaa',
  v=>v.notificationLedger.token='a'.repeat(64),v=>v.notificationLedger.queue=[{}],v=>v.daily.push({}),v=>v.sourceJournal.sources[key].secretKey='forbidden',
  v=>v.sourceJournal.deliveries.bad='not-a-hash',v=>v.notificationLedger.scheduled[0].goalId='other_goal'];
 for(const change of variants){const v=clone(value);change(v);assert.throws(()=>validateHostCompanion(v));}
 assert.throws(()=>stagedHostCompanion(value,{...manifest,hostCompanionSHA256:'0'.repeat(64)},targetReceipt));
 const m={...manifest,sourceHolds:manifest.sourceHolds.map(h=>({...h,sourceRevision:3}))};
 assert.throws(()=>stagedHostCompanion(value,m,{...targetReceipt,sourceHolds:expectedHandoffHolds(m)}));
 const v=clone(value);v.sourceJournal.sources[key].current.capabilities=['trading_account_summary'];
 assert.throws(()=>stagedHostCompanion(v,{...manifest,hostCompanionSHA256:digest(v),sourceHolds:[]},{snapshotSHA256:manifest.snapshotSHA256,syncHighWaterMark:117,sourceHolds:[]}));
});
test('export/install is bounded, private and repeatable; a different target ledger is never overwritten',()=>{
 const root=mkdtempSync(join(tmpdir(),'along-companion-'));try{
  const {value,manifest,targetReceipt}=fixture(),source=join(root,'source'),target=join(root,'target');mkdirSync(source,{mode:0o700});mkdirSync(target,{mode:0o700});
  mkdirSync(join(source,'source-events'),{mode:0o700});writePrivateHandoffJSON(join(source,'source-events','journal.json'),value.sourceJournal);
  writePrivateHandoffJSON(join(source,`notification-device.${u}.json`),value.notificationLedger);
  savePairings(source,[{hash:value.sourceCredentialSHA256,user_id:u,device_id:d,expiresAt:Date.now()+86400000}]);
  const companionFile=join(root,'companion.json');const result=exportHostCompanion({hostStateDir:source,sourceUserId:u,sourceDeviceId:d,sourceCredentialSHA256:value.sourceCredentialSHA256,goalIds:[g],outputFile:companionFile});
  assert.equal(result.hostCompanionSHA256,manifest.hostCompanionSHA256);assert.equal(result.deduplications,1);assert.equal(result.scheduled,1);
  const args={hostStateDir:target,companionFile,manifest,targetReceipt};const receipt=installHostCompanion(args);assert.deepEqual(installHostCompanion(args),receipt);
  assert.equal(JSON.parse(readFileSync(join(target,'source-events','journal.json'))).sources[key].current.state,'unavailable');
  const other=join(root,'other');mkdirSync(other,{mode:0o700});mkdirSync(join(other,'source-events'),{mode:0o700});writePrivateHandoffJSON(join(other,'source-events','journal.json'),{version:1,sources:{},deliveries:{}});
  assert.throws(()=>installHostCompanion({...args,hostStateDir:other}));assert.deepEqual(JSON.parse(readFileSync(join(other,'source-events','journal.json'))).sources,{});
  writePrivateHandoffJSON(join(source,'daily-grant-unknown.json'),{});assert.throws(()=>exportHostCompanion({hostStateDir:source,sourceUserId:u,sourceDeviceId:d,sourceCredentialSHA256:value.sourceCredentialSHA256,goalIds:[g],outputFile:companionFile}));
 }finally{rmSync(root,{recursive:true,force:true});}
});
