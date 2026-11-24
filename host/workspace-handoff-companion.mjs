// Scoped cold Host state only. Raw gateway payloads, device/API secrets and daily authority
// are deliberately not portable. Unknown/unsettled state is refused before publication.
import {existsSync,lstatSync,mkdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {readPairings} from './pairing.mjs';
import {canonicalHandoffJSON,handoffDigest,readPrivateHandoffJSON,writePrivateHandoffJSON,expectedHandoffHolds,validateHandoffTargetReceipt} from './workspace-handoff.mjs';

const exact=(x,keys)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join('|')===[...keys].sort().join('|');
const hash=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(x);
const opaque=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const stamp=x=>integer(x)&&x>0;
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
const digest=x=>handoffDigest(canonicalHandoffJSON(x));
const sourceKey=(u,g,p)=>handoffDigest(JSON.stringify([u,g,p]));
const clone=x=>JSON.parse(JSON.stringify(x));
function fail(){throw Error('Host交接状态不是可迁移的单用户静止白名单');}
function privateDir(dir){const s=lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid())fail();}
function journal(value,userId,goals) {
  if(!exact(value,['version','sources','deliveries'])||value.version!==1||!exact(value.sources,Object.keys(value.sources??{}))||
    !exact(value.deliveries,Object.keys(value.deliveries??{}))||Object.entries(value.deliveries).some(([k,v])=>!hash(k)||!hash(v)))fail();
  for(const [key,row] of Object.entries(value.sources)) {
    if(!exact(row,['userId','goalId','provider','generation','revision','current','pending','outbox','producerVersions','retired'])||
      row.userId!==userId||!goals.includes(row.goalId)||row.provider!=='okx'||key!==sourceKey(userId,row.goalId,row.provider)||
      !integer(row.generation)||!integer(row.revision)||row.pending!==null||!Array.isArray(row.outbox)||row.outbox.length||
      !exact(row.producerVersions,Object.keys(row.producerVersions??{}))||Object.entries(row.producerVersions).some(([k,v])=>!opaque(k)||!stamp(v))||
      !Array.isArray(row.retired)||row.retired.some(x=>!opaque(x)))fail();
    const c=row.current;
    if(c===null)continue;
    const base=['generation','revision','reference','occurredAt','state'];
    const allowed=[...base,'connectionId','producerVersion','digest','capabilities'];
    if(!c||!base.every(k=>Object.hasOwn(c,k))||Object.keys(c).some(k=>!allowed.includes(k))||
      !stamp(c.generation)||!stamp(c.revision)||row.generation<c.generation||row.revision<c.revision||!opaque(c.reference)||!iso(c.occurredAt)||
      !['ready','revoked','disconnected','unavailable'].includes(c.state)||
      c.connectionId!==undefined&&(!opaque(c.connectionId)||!stamp(c.producerVersion)||row.producerVersions[c.connectionId]!==c.producerVersion)||
      c.producerVersion!==undefined&&c.connectionId===undefined||
      (c.state==='ready'?!hash(c.digest):c.digest!==undefined)||
      c.capabilities!==undefined&&(c.state!=='ready'||!['["trading_account_summary"]','["trading_account_summary","trading_history"]'].includes(JSON.stringify(c.capabilities))))fail();
  }
  return value;
}
function notification(value,userId,deviceId,goals) {
  if(value===null)return null;
  const fields=['userId','deviceId','token','cursor','enabledAt','seen','queue','scheduled'];
  if(!fields.every(k=>Object.hasOwn(value,k))||Object.keys(value).some(k=>![...fields,'environment'].includes(k))||
    value.userId!==userId||value.deviceId!==deviceId||value.token!==null||!integer(value.cursor)||!integer(value.enabledAt)||
    !Array.isArray(value.seen)||!Array.isArray(value.queue)||value.queue.length||!Array.isArray(value.scheduled)||value.scheduled.length>64)fail();
  if(value.seen.some(r=>!exact(r,['id','expires'])||typeof r.id!=='string'||r.id.length>180||!Number.isFinite(r.expires)))fail();
  for(const r of value.scheduled) {
    const required=['goalId','taskId','revision','scheduledAt'],allowed=[...required,'repeat','timezone','weekday','firstScheduledAt','wallTime'];
    if(!required.every(k=>Object.hasOwn(r,k))||Object.keys(r).some(k=>!allowed.includes(k))||!goals.includes(r.goalId)||!id(r.taskId)||!integer(r.revision)||!iso(r.scheduledAt)||
      r.repeat!==undefined&&(!['daily','weekly'].includes(r.repeat)||typeof r.timezone!=='string'||!iso(r.firstScheduledAt)||
        r.repeat==='weekly'&&(!stamp(r.weekday)||r.weekday>7)||r.repeat==='daily'&&r.weekday!==undefined)||r.wallTime!==undefined&&!iso(r.wallTime))fail();
    if(r.repeat)try{new Intl.DateTimeFormat('en',{timeZone:r.timezone});}catch{fail();}
  }
  return value;
}
export function validateHostCompanion(value) {
  if(!exact(value,['format','sourceUserId','sourceDeviceId','sourceCredentialSHA256','goalIds','sourceJournal','notificationLedger','daily'])||
    value.format!=='along-host-personal-handoff/v1'||!/^u_[0-9a-f]{8}$/.test(value.sourceUserId)||!/^d_[0-9a-f]{8}$/.test(value.sourceDeviceId)||
    !hash(value.sourceCredentialSHA256)||!Array.isArray(value.goalIds)||!value.goalIds.length||value.goalIds.some(g=>!id(g))||
    new Set(value.goalIds).size!==value.goalIds.length||!Array.isArray(value.daily)||value.daily.length)fail();
  journal(value.sourceJournal,value.sourceUserId,value.goalIds);
  notification(value.notificationLedger,value.sourceUserId,value.sourceDeviceId,value.goalIds);
  return value;
}
export function exportHostCompanion({hostStateDir,sourceUserId,sourceDeviceId,sourceCredentialSHA256,goalIds,outputFile}) {
  privateDir(hostStateDir);
  const bindings=readPairings(hostStateDir);
  if(bindings.length!==1||bindings[0].user_id!==sourceUserId||bindings[0].device_id!==sourceDeviceId||bindings[0].hash!==sourceCredentialSHA256||
    readdirSync(hostStateDir).some(name=>/^daily-grant-.*\.json$/.test(name)||name==='current-daily-actions.json'||
      /^notification-device\..*\.json$/.test(name)&&name!==`notification-device.${sourceUserId}.json`))fail();
  const journalFile=join(hostStateDir,'source-events','journal.json'),notificationFile=join(hostStateDir,`notification-device.${sourceUserId}.json`);
  const value=validateHostCompanion({format:'along-host-personal-handoff/v1',sourceUserId,sourceDeviceId,sourceCredentialSHA256,goalIds,
    sourceJournal:existsSync(journalFile)?readPrivateHandoffJSON(journalFile):{version:1,sources:{},deliveries:{}},
    notificationLedger:existsSync(notificationFile)?readPrivateHandoffJSON(notificationFile):null,daily:[]});
  writePrivateHandoffJSON(outputFile,value);
  return {exported:true,hostCompanionSHA256:digest(value),sources:Object.keys(value.sourceJournal.sources).length,
    scheduled:value.notificationLedger?.scheduled.length??0,deduplications:Object.keys(value.sourceJournal.deliveries).length};
}
export function stagedHostCompanion(value,manifest,targetReceipt) {
  validateHostCompanion(value);validateHandoffTargetReceipt(manifest,targetReceipt);
  if(!hash(manifest.hostCompanionSHA256)||digest(value)!==manifest.hostCompanionSHA256||value.sourceUserId!==manifest.sourceUserId||
    value.sourceDeviceId!==manifest.sourceDeviceId||canonicalHandoffJSON(value.goalIds)!==canonicalHandoffJSON(manifest.goalIds))fail();
  const next=clone(value.sourceJournal);
  for(const hold of expectedHandoffHolds(manifest)) {
    const row=next.sources[sourceKey(value.sourceUserId,hold.goalId,hold.provider)],c=row?.current;
    if(!c||c.state!=='ready'||!c.capabilities?.includes('trading_history')||c.generation!==hold.sourceGeneration||c.revision!==hold.sourceRevision)fail();
    row.current={generation:hold.generation,revision:hold.revision,reference:'handoff:'+manifest.migrationId+':cloud_history_unsupported',
      occurredAt:manifest.createdAt,state:'unavailable',...(c.connectionId?{connectionId:c.connectionId,producerVersion:c.producerVersion}:{})};
    row.generation=Math.max(row.generation,hold.generation);row.revision=Math.max(row.revision,hold.revision);
  }
  // No ready fact may claim a gateway snapshot that was deliberately kept only on the Mac.
  if(Object.values(next.sources).some(row=>row.current?.state==='ready'))fail();
  return {journal:next,notificationLedger:clone(value.notificationLedger)};
}
export function installHostCompanion({hostStateDir,companionFile,manifest,targetReceipt}) {
  privateDir(hostStateDir);
  const value=readPrivateHandoffJSON(companionFile),next=stagedHostCompanion(value,manifest,targetReceipt);
  const receipt={format:'along-host-companion-receipt/v1',migrationId:manifest.migrationId,hostCompanionSHA256:manifest.hostCompanionSHA256,
    sourceUserId:manifest.sourceUserId,sourceDeviceId:manifest.sourceDeviceId,sourceCredentialSHA256:value.sourceCredentialSHA256,
    installedJournalSHA256:digest(next.journal),installedNotificationSHA256:digest(next.notificationLedger)};
  const marker=join(hostStateDir,'personal-handoff-companion.json');
  if(existsSync(marker)) {if(canonicalHandoffJSON(readPrivateHandoffJSON(marker))!==canonicalHandoffJSON(receipt))fail();return receipt;}
  if(readdirSync(hostStateDir).some(name=>/^daily-grant-.*\.json$/.test(name)||name==='current-daily-actions.json'))fail();
  const sources=join(hostStateDir,'source-events');
  if(!existsSync(sources))mkdirSync(sources,{mode:0o700});privateDir(sources);
  const journalFile=join(sources,'journal.json'),notificationFile=join(hostStateDir,`notification-device.${manifest.sourceUserId}.json`);
  // Each pre-marker write is repeatable only when exactly equal; never overwrite different state.
  const write=(file,data)=>{if(existsSync(file)){if(canonicalHandoffJSON(readPrivateHandoffJSON(file))!==canonicalHandoffJSON(data))fail();}
    else writePrivateHandoffJSON(file,data);};
  write(journalFile,next.journal);if(next.notificationLedger)write(notificationFile,next.notificationLedger);
  writePrivateHandoffJSON(marker,receipt);return receipt;
}
