/** Host-owned source facts and narrow cached reads. No phone route, arbitrary URL, account secret or summary bus. */
import {createHash,randomBytes} from 'node:crypto';
import {constants,openSync,closeSync,readFileSync,writeFileSync,mkdirSync,lstatSync,fstatSync,chmodSync,renameSync,unlinkSync,fsyncSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {requireOkxGoal} from './source-access.mjs';
import {validOkxHistory,okxDataDigest,okxPerformanceReport} from './okx-history.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/;
const OPAQUE=/^[A-Za-z0-9_-]{1,160}$/;
const STATES=new Set(['ready','disconnected','revoked','unavailable']);
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>record(x)&&Object.keys(x).every(k=>keys.includes(k));
const positive=x=>Number.isSafeInteger(x)&&x>0;
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
const clone=x=>JSON.parse(JSON.stringify(x));
const key=(userId,goalId,provider='okx')=>createHash('sha256').update(JSON.stringify([userId,goalId,provider])).digest('hex');
const stampOf=s=>s?{generation:s.generation,revision:s.revision,reference:s.reference,occurredAt:s.occurredAt}:null;
export const sourceDigest=okxDataDigest;
export const validSourceStamp=s=>exact(s,['generation','revision','reference','occurredAt'])&&positive(s.generation)&&positive(s.revision)&&OPAQUE.test(s.reference??'')&&iso(s.occurredAt);
const summary=x=>exact(x,['tradingEquityUsd','assetCount','positionCount'])&&Object.keys(x).length===3&&Number.isFinite(x.tradingEquityUsd)&&Number.isSafeInteger(x.assetCount)&&x.assetCount>=0&&Number.isSafeInteger(x.positionCount)&&x.positionCount>=0;
const event=(row,state)=>({event_id:'source_'+createHash('sha256').update(JSON.stringify([row.userId,row.goalId,row.provider??'okx',state.generation,state.revision,state.reference,state.state])).digest('hex').slice(0,40),
 goal_id:row.goalId,provider:row.provider??'okx',generation:state.generation,revision:state.revision,state:state.state,
 capabilities:state.state==='ready'&&(row.provider??'okx')==='okx'?(state.capabilities??['trading_account_summary']):[],occurred_at:state.occurredAt,reference:state.reference});
export class SourceBridgeError extends Error{constructor(code){super('Host source bridge unavailable');this.name='SourceBridgeError';this.code=code;}}
const fail=code=>{throw new SourceBridgeError(code);};

/** One private atomic journal: reservations and current facts/outbox share a single commit. No raw account values. */
export function createSourceJournal({dir,now=Date.now}={}){
 if(typeof dir!=='string'||!dir||typeof now!=='function')fail('invalid_config');
 const root=resolve(dir),file=join(root,'journal.json');
 const timestamp=()=>{const n=Number(now());if(!Number.isFinite(n))fail('invalid_clock');return new Date(n).toISOString();};
 function directory(){mkdirSync(root,{recursive:true,mode:0o700});const s=lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink()||typeof process.getuid==='function'&&s.uid!==process.getuid())fail('journal_unavailable');chmodSync(root,0o700);}
 function read(){
  directory();let fd;
  try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const s=fstatSync(fd);
   if(!s.isFile()||s.nlink!==1||(s.mode&0o077)!==0||s.size>4*1024*1024||typeof process.getuid==='function'&&s.uid!==process.getuid())fail('journal_unavailable');
   const value=JSON.parse(readFileSync(fd,'utf8'));if(value?.version!==1||!record(value.sources)||!record(value.deliveries))fail('journal_unavailable');return value;
  }catch(e){if(e?.code==='ENOENT')return{version:1,sources:{},deliveries:{}};if(e instanceof SourceBridgeError)throw e;fail('journal_unavailable');}
  finally{if(fd!==undefined)closeSync(fd);}
 }
 function write(value){let fd,path;try{directory();path=join(root,'journal.'+randomBytes(8).toString('hex')+'.tmp');fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(path,file);path=undefined;}catch{fail('journal_unavailable');}finally{if(fd!==undefined)closeSync(fd);if(path)try{unlinkSync(path);}catch{}}}
 function binding(userId,goalId,provider='okx'){if(!ID.test(userId??'')||!ID.test(goalId??'')||!/^[a-z][a-z0-9-]{0,40}$/.test(provider))fail('invalid_identity');return key(userId,goalId,provider);}
 function getRow(db,userId,goalId,provider='okx'){const k=binding(userId,goalId,provider);return db.sources[k]??(db.sources[k]={userId,goalId,provider,generation:0,revision:0,current:null,pending:null,outbox:[],producerVersions:{},retired:[]});}
 function publish(row,state){row.current=state;row.pending=null;row.generation=Math.max(row.generation,state.generation);row.revision=Math.max(row.revision,state.revision);
  const fact=event(row,state);row.outbox=[{event:fact}];return clone(fact);
 }
 return {
  /** Called only after a trusted producer's admission/storage commit, never with UI/model claims.
   * lookup reconciliation can repeat this exact fact after a crash between that commit and journalling. */
  recordVerifiedState(identity,goalId,provider,metadata){
   if(!identity||!ID.test(identity.userId??'')||!ID.test(identity.deviceId??'')||!exact(metadata,['connectionId','version','state','observedAt','digest','capabilities'])||
      !OPAQUE.test(metadata.connectionId??'')||!positive(metadata.version)||!STATES.has(metadata.state)||!iso(metadata.observedAt)||
      metadata.state==='ready'&&!/^[a-f0-9]{64}$/.test(metadata.digest??'')||metadata.capabilities!==undefined&&
      (metadata.state!=='ready'||!Array.isArray(metadata.capabilities)||!['["trading_account_summary"]','["trading_account_summary","trading_history"]'].includes(JSON.stringify(metadata.capabilities))))fail('invalid_verified_fact');
   const db=read(),row=getRow(db,identity.userId,goalId,provider),old=row.current,versions=row.producerVersions??={},retired=row.retired??[];
   const seen=Object.hasOwn(versions,metadata.connectionId)?versions[metadata.connectionId]:0;
   if(metadata.version<seen||retired.includes(metadata.connectionId))return{status:'stale',sourceStamp:stampOf(old),state:old?.state??'unavailable'};
   if(metadata.version===seen){
    if(old?.connectionId===metadata.connectionId&&old.state===metadata.state&&(metadata.state!=='ready'||old.digest===metadata.digest))return{status:'duplicate',sourceStamp:stampOf(old),state:old.state};
    return{status:'stale',sourceStamp:stampOf(old),state:old?.state??'unavailable'};
   }
   if(old?.connectionId&&old.connectionId!==metadata.connectionId&&metadata.state!=='ready')return{status:'stale',sourceStamp:stampOf(old),state:old.state};
   Object.defineProperty(versions,metadata.connectionId,{value:metadata.version,writable:true,enumerable:true,configurable:true});row.producerVersions=versions;row.retired=retired;
   if(old?.connectionId===metadata.connectionId&&old.state===metadata.state&&(metadata.state!=='ready'||old.digest===metadata.digest)){
    old.producerVersion=metadata.version;write(db);return{status:'duplicate',sourceStamp:stampOf(old),state:old.state};
   }
   if(old?.connectionId&&old.connectionId!==metadata.connectionId)retired.push(old.connectionId);
   if(['disconnected','revoked'].includes(metadata.state))retired.push(metadata.connectionId);
   const sameEpoch=old?.connectionId===metadata.connectionId&&!['disconnected','revoked'].includes(metadata.state);
   const generation=sameEpoch?old.generation:row.generation+1,revision=row.revision+1;
   if(!positive(generation)||!positive(revision))fail('version_exhausted');
   const current={generation,revision,reference:'src_'+randomBytes(20).toString('hex'),occurredAt:timestamp(),state:metadata.state,connectionId:metadata.connectionId,producerVersion:metadata.version,...(metadata.state==='ready'?{digest:metadata.digest,...(metadata.capabilities?{capabilities:[...metadata.capabilities]}:{})}:{})};
   publish(row,current);write(db);return{status:'accepted',sourceStamp:stampOf(current),state:current.state};
  },
  prepareReady({userId,goalId,operation,digest,priorStamp}){
   if(!['connect','refresh','adopt'].includes(operation)||!/^\w{64}$/.test(digest??''))fail('invalid_transition');
   const db=read(),row=getRow(db,userId,goalId),current=row.current;
   if(operation!=='connect'&&current?.state==='ready'&&current.digest===digest&&validSourceStamp(priorStamp)&&current.reference===priorStamp.reference){return clone(priorStamp);}
   if(operation==='adopt'&&validSourceStamp(priorStamp)&&(!current||priorStamp.revision>current.revision&&priorStamp.generation>=current.generation)){
    row.generation=Math.max(row.generation,priorStamp.generation);row.revision=Math.max(row.revision,priorStamp.revision);row.pending={...priorStamp,state:'ready',digest};write(db);return clone(priorStamp);
   }
   const generation=operation==='refresh'&&current?.state==='ready'?current.generation:Math.max(row.generation,priorStamp?.generation??0)+1;
   const revision=Math.max(row.revision,priorStamp?.revision??0)+1;
   if(!positive(generation)||!positive(revision))fail('version_exhausted');
   const stamp={generation,revision,reference:'src_'+randomBytes(20).toString('hex'),occurredAt:timestamp()};
   row.generation=generation;row.revision=revision;row.pending={...stamp,state:'ready',digest};write(db);return stamp;
  },
  prepareAbsent({userId,goalId,provider='okx',state='disconnected'}){
   if(!STATES.has(state)||state==='ready')fail('invalid_transition');const db=read(),row=getRow(db,userId,goalId,provider);
   if(row.pending?.state===state)return clone(row.pending);
   if(row.current?.state===state&&!row.pending)return clone(row.current);
   if(row.current?.connectionId&&!['unavailable'].includes(state)){row.retired??=[];row.retired.push(row.current.connectionId);}
   const stamp={generation:row.generation+1,revision:row.revision+1,reference:'src_'+randomBytes(20).toString('hex'),occurredAt:timestamp()};
   if(!positive(stamp.generation)||!positive(stamp.revision))fail('version_exhausted');row.generation=stamp.generation;row.revision=stamp.revision;row.pending={...stamp,state};write(db);return clone(row.pending);
  },
  commitSaved({userId,goalId,stamp,digest}){
   if(!validSourceStamp(stamp))fail('invalid_stamp');const db=read(),row=getRow(db,userId,goalId);
   if(row.current?.state==='ready'&&row.current.reference===stamp.reference&&row.current.digest===digest)return clone(row.current);
   if(!row.pending||row.pending.state!=='ready'||row.pending.reference!==stamp.reference||row.pending.digest!==digest)fail('unreserved_stamp');
   const result=publish(row,row.pending);write(db);return result;
  },
  recover({userId,goalId,stamp,digest,missing=false}){
   const db=read(),row=getRow(db,userId,goalId);
   if(missing){
    if(row.pending&&row.pending.state!=='ready'){publish(row,row.pending);write(db);return;}
    if(row.pending){row.pending=null;write(db);}return;
   }
   if(!validSourceStamp(stamp))fail('invalid_stamp');
   if(row.current?.reference===stamp.reference&&row.current.state==='ready'&&row.current.digest===digest){if(row.pending){row.pending=null;write(db);}return;}
   if(row.pending?.reference===stamp.reference&&row.pending.state==='ready'&&row.pending.digest===digest){publish(row,row.pending);write(db);return;}
   if(!row.current||stamp.generation>=row.current.generation&&stamp.revision>row.current.revision){publish(row,{...stamp,state:'ready',digest});write(db);return;}
   fail('stale_vault_stamp');
  },
  commitAbsent({userId,goalId,provider='okx',stamp}){
   const db=read(),row=getRow(db,userId,goalId,provider);
   if(row.current?.reference===stamp?.reference&&row.current.state!=='ready')return clone(row.current);
   if(!row.pending||row.pending.state==='ready'||row.pending.reference!==stamp?.reference)fail('unreserved_stamp');const value=publish(row,row.pending);write(db);return value;
  },
  current(userId,goalId,provider='okx'){const db=read(),r=db.sources[binding(userId,goalId,provider)];return r?.current?clone(r.current):null;},
  sources(userId){return Object.values(read().sources).filter(r=>r.userId===userId).map(r=>({userId:r.userId,goalId:r.goalId,provider:r.provider??'okx',current:r.current?clone(r.current):null}));},
  outbox(userId){return Object.values(read().sources).filter(r=>r.userId===userId).flatMap(r=>r.outbox.map(o=>({userId:r.userId,...event(r,{...o.event,occurredAt:o.event.occurred_at})})));},
  acknowledge(userId,goalId,eventId,provider='okx'){const db=read(),r=db.sources[binding(userId,goalId,provider)];if(!r)return;r.outbox=r.outbox.filter(o=>o.event.event_id!==eventId);write(db);},
  reference(userId,goalId,generation,revision,provider='okx'){const r=read().sources[binding(userId,goalId,provider)];return[r?.current,r?.pending].find(s=>s?.generation===generation&&s?.revision===revision)?.reference??'unavailable';},
  delivered(userId,requestId,hash){return read().deliveries[key(userId,requestId)]===hash;},
  markDelivered(userId,requestId,hash){const db=read();db.deliveries[key(userId,requestId)]=hash;const keys=Object.keys(db.deliveries);for(const k of keys.slice(0,Math.max(0,keys.length-500)))delete db.deliveries[k];write(db);},
 };
}

const requestValid=r=>exact(r,['request_id','goal_id','provider','capability','generation','revision','max_age_seconds'])&&ID.test(r.request_id??'')&&ID.test(r.goal_id??'')&&r.provider==='okx'&&['trading_account_summary','trading_history'].includes(r.capability)&&positive(r.generation)&&positive(r.revision)&&Number.isSafeInteger(r.max_age_seconds)&&r.max_age_seconds>=1&&r.max_age_seconds<=86400;
/** A bounded pump in the existing Host process. Adapters read admitted, persisted producer records.
 * The vault adapter is compatibility only; native producers never copy credentials back to it. */
export function createSourceEventBridge({journal,connection,bridge,endpoint,identity,isAuthorized,readGoals,adapters,now=Date.now,onError=()=>{}}={}){
 const url=new URL(endpoint);if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('private_loopback_required');
 const providers=adapters??{okx:{
  authorized:isAuthorized,listGoals:readGoals,
  hasSaved:(who,goalId)=>connection.hasSavedSource({userId:who.userId,goalId}),
  lookup:(who,goalId)=>connection.sourceSnapshot({userId:who.userId,goalId,stillAuthorized:()=>active(who)&&isAuthorized(who,goalId)}),
  revoke:(who,goalId)=>connection.handle({userId:who.userId,goalId,input:{action:'disconnect'},sourceState:'revoked',stillAuthorized:()=>active(who),revokeIf:async()=>active(who)&&!(await isAuthorized(who,goalId))}),
 }};
 for(const [provider,a] of Object.entries(providers))if(provider!=='okx'||!a||!['authorized','listGoals','lookup'].every(k=>typeof a[k]==='function'))fail('invalid_source_adapter');
 let busy=false,closed=false;
 const active=who=>!closed&&identity()===who;
 const report=e=>{try{onError(e instanceof SourceBridgeError?e.code:'source_delivery_failed');}catch{}};
 const allowed=(who,goalId,provider)=>providers[provider].authorized(who,goalId);
 async function snapshot(who,goalId,provider){
  const value=await providers[provider].lookup(who,goalId,{metadataOnly:false});
  if(!active(who)||!value)return null;
  if(value.metadata){
   if(value.metadata.state==='ready'&&(!summary(value.summary)||value.history!==undefined&&!validOkxHistory(value.history,value.metadata.observedAt)||sourceDigest(value.summary,value.history)!==value.metadata.digest))fail('invalid_source_snapshot');
   const recorded=journal.recordVerifiedState(who,goalId,provider,value.metadata);
   const current=journal.current(who.userId,goalId,provider);
   if(recorded.state!=='ready'||current?.connectionId!==value.metadata.connectionId||current.producerVersion!==value.metadata.version)return null;
   return{sourceStamp:recorded.sourceStamp,observedAt:value.metadata.observedAt,summary:value.summary,...(value.history?{history:value.history}:{})};
  }
  return value;
 }
 async function reconcile(who){
  for(const [provider,adapter] of Object.entries(providers)){
   const goals=new Set(journal.sources(who.userId).filter(s=>s.provider===provider).map(s=>s.goalId));
   const found=await adapter.listGoals(who);if(!Array.isArray(found)||found.some(g=>!ID.test(g)))fail('invalid_source_goals');
   for(const goalId of found)goals.add(goalId);
   for(const goalId of goals){
    if(!active(who))return;
    let canRead;try{canRead=await allowed(who,goalId,provider);}catch{continue;}
    if(!active(who))return;
    if(!canRead){
     let current=journal.current(who.userId,goalId,provider);
     const saved=adapter.hasSaved?adapter.hasSaved(who,goalId):!!(await adapter.lookup(who,goalId,{metadataOnly:true}));
     if(!active(who))return;if(!current&&!saved)continue;
     try{
      if(adapter.revoke)await adapter.revoke(who,goalId);
      if(!active(who))return;
      current=journal.current(who.userId,goalId,provider);
      if(!current||!['revoked','disconnected'].includes(current.state)){
       const stamp=journal.prepareAbsent({userId:who.userId,goalId,provider,state:'revoked'});journal.commitAbsent({userId:who.userId,goalId,provider,stamp});
      }
     }catch(e){report(e);}continue;
    }
    try{await snapshot(who,goalId,provider);}catch(e){report(e);}
   }
  }
 }
 async function flush(who){
  for(const item of journal.outbox(who.userId).filter(e=>providers[e.provider]).slice(0,30)){
   if(!active(who))return false;const {userId,...value}=item,provider=item.provider;
   const current=journal.current(who.userId,item.goal_id,provider);
   if(current?.reference!==item.reference){journal.acknowledge(who.userId,item.goal_id,item.event_id,provider);continue;}
   if(item.state==='ready'){
    if(!await allowed(who,item.goal_id,provider)||!active(who))return false;
    const currentSnapshot=await snapshot(who,item.goal_id,provider);
    if(currentSnapshot?.sourceStamp?.reference!==item.reference||journal.current(who.userId,item.goal_id,provider)?.reference!==item.reference)return false;
   }
   if(!active(who))return false;
   const reply=await bridge.call('/along-source/api/source-events',{value,identity:who,timeout:5000});
   if(!active(who))return false;
   if(reply?.event_id!==item.event_id||!['accepted','stale'].includes(reply?.status))fail('invalid_source_receipt');
   journal.acknowledge(who.userId,item.goal_id,item.event_id,provider);
  }
  return journal.outbox(who.userId).filter(e=>providers[e.provider]).length===0;
 }
 async function readRequests(who){
  const page=await bridge.call('/along-source/api/source-reads?user_id='+encodeURIComponent(who.userId),{method:'GET',identity:who,timeout:5000});
  if(!Array.isArray(page?.requests)||page.requests.length>50)fail('invalid_read_requests');
  for(const request of page.requests){
   if(!active(who))return;if(!requestValid(request)){report(new SourceBridgeError('invalid_read_request'));continue;}
   const provider=request.provider,ref=journal.reference(who.userId,request.goal_id,request.generation,request.revision,provider);
   let result={request_id:request.request_id,state:'unavailable',generation:request.generation,revision:request.revision,observed_at:new Date(now()).toISOString(),reference:ref};
   let canRead;try{canRead=!!providers[provider]&&await allowed(who,request.goal_id,provider);}catch(e){report(e);}
   if(!active(who))return;
   const known=journal.current(who.userId,request.goal_id,provider);
   if(canRead===false||known&&(known.generation!==request.generation||['revoked','disconnected'].includes(known.state)||
     !(known.capabilities??['trading_account_summary']).includes(request.capability)))result.state='denied';
   else if(canRead===true)try{
    const value=await snapshot(who,request.goal_id,provider),stamp=value?.sourceStamp;
    if(!value||!validSourceStamp(stamp))result.state='unavailable';
    else if(stamp.generation!==request.generation)result.state='denied';
    else if(stamp.revision<request.revision)result.state='stale';
    else{
     const history=request.capability==='trading_history';
     const observation=history?value.history?.windowEnd:value.observedAt;
     result={...result,generation:stamp.generation,revision:stamp.revision,reference:stamp.reference,observed_at:observation??value.observedAt};
     const age=Number(now())-Date.parse(observation);
     if(!summary(value.summary)||history&&!validOkxHistory(value.history,value.observedAt)||!Number.isFinite(age)||age<0)result.state='unavailable';
     else if(age>request.max_age_seconds*1000)result.state='stale';
     else{result.state='ready';result.data=history?okxPerformanceReport(value.history):{...value.summary};}
    }
   }catch(e){report(e);}
   if(!active(who))return;
   if(!await flush(who))return;
   // An awaited delivery may have crossed a disconnect, pairing or goal-revocation boundary.
   if(result.state==='ready'){
    const allowedNow=await allowed(who,request.goal_id,provider),current=journal.current(who.userId,request.goal_id,provider);
    if(!active(who))return;
    if(!allowedNow||current?.state!=='ready'||current.generation!==result.generation||current.revision!==result.revision||current.reference!==result.reference||!(current.capabilities??['trading_account_summary']).includes(request.capability)){
     result={request_id:request.request_id,state:'denied',generation:request.generation,revision:request.revision,observed_at:new Date(now()).toISOString(),reference:ref};
    }
   }
   if(!active(who))return;
   const hash=createHash('sha256').update(JSON.stringify(result)).digest('hex');
   const dedup=result.state==='ready'?hash:createHash('sha256').update(JSON.stringify({...result,observed_at:null})).digest('hex');
   if(journal.delivered(who.userId,request.request_id,dedup))continue;
   const reply=await bridge.call('/along-source/api/source-read-results',{value:result,identity:who,timeout:5000});
   if(!active(who))return;
   if(reply?.request_id!==request.request_id||!['accepted','reused'].includes(reply?.status))fail('invalid_read_receipt');
   journal.markDelivered(who.userId,request.request_id,dedup);
  }
 }
 return {
  async pump(){if(busy||closed)return;const who=identity();if(!who)return;busy=true;try{await reconcile(who);if(active(who)&&await flush(who))await readRequests(who);}catch(e){report(e);}finally{busy=false;}},
  close(){closed=true;},
 };
}

/** Production wiring shared by the vault and later admitted-native-summary adapters. */
export function createHostSourceEventBridge(options){
 const {bridge,identity}=options;
 const authorized=async(who,goalId)=>{
  if(identity()!==who)return false;
  const detail=await bridge.call('/along-source/api/goals/'+encodeURIComponent(goalId),{method:'GET',identity:who,timeout:5000});
  try{requireOkxGoal(detail,who,goalId);}catch(error){if(error?.status===403)return false;throw error;}
  return identity()===who;
 };
 const listGoals=async who=>{
  const result=[];let cursor;
  do{
   const query=new URLSearchParams({user_id:who.userId,limit:'200',...(cursor?{cursor}:{})});
   const page=await bridge.call('/along-source/api/goals?'+query,{method:'GET',identity:who,timeout:5000});
   if(!Array.isArray(page?.items)||page.items.some(g=>!ID.test(g?.id??'')))fail('invalid_source_goals');
   result.push(...page.items.map(g=>g.id));
   if(page.nextCursor!==undefined&&page.nextCursor!==null&&typeof page.nextCursor!=='string')fail('invalid_source_goals');
   if(page.nextCursor&&page.nextCursor===cursor)fail('invalid_source_cursor');cursor=page.nextCursor||undefined;
  }while(cursor);
  return result;
 };
 const adapters=options.adapters?Object.fromEntries(Object.entries(options.adapters).map(([provider,adapter])=>[provider,{...adapter,authorized}])):undefined;
 return createSourceEventBridge({...options,isAuthorized:authorized,readGoals:listGoals,...(adapters?{adapters}:{})});
}
