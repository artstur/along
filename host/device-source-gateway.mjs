import {createHash,randomBytes} from 'node:crypto';
import {constants,existsSync,openSync,closeSync,readFileSync,writeFileSync,mkdirSync,lstatSync,fstatSync,chmodSync,renameSync,unlinkSync,fsyncSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {validOkxHistory,okxDataDigest,hasOkxHistory} from './okx-history.mjs';

const QUEUES=new Map(),ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/,GRANT=/^[a-f0-9]{64}$/;
const validId=x=>typeof x==='string'&&ID.test(x);
const MESSAGES={invalid_request:'设备数据请求无效。',event_conflict:'此设备事件与已保存内容冲突。',stale_authorization:'目标或配对已变化，请重新连接。',storage_unavailable:'设备数据缓存暂不可用。'};
export class DeviceSourceError extends Error {constructor(code){super(MESSAGES[code]??MESSAGES.storage_unavailable);this.name='DeviceSourceError';this.code=Object.hasOwn(MESSAGES,code)?code:'storage_unavailable';this.status=this.code==='event_conflict'?409:this.code==='stale_authorization'?403:this.code==='storage_unavailable'?503:400;}}
const fail=code=>{throw new DeviceSourceError(code);};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).every(k=>keys.includes(k));
const validSummary=x=>exact(x,['tradingEquityUsd','assetCount','positionCount'])&&Object.keys(x).length===3&&Number.isFinite(x.tradingEquityUsd)&&Number.isSafeInteger(x.assetCount)&&x.assetCount>=0&&Number.isSafeInteger(x.positionCount)&&x.positionCount>=0;
const iso=x=>typeof x==='string'&&x.length<=40&&/^\d{4}-\d\d-\d\dT/.test(x)&&Number.isFinite(Date.parse(x));
const stamp=x=>exact(x,['generation','revision','reference','occurredAt'])&&Number.isSafeInteger(x.generation)&&x.generation>0&&Number.isSafeInteger(x.revision)&&x.revision>0&&typeof x.reference==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(x.reference)&&iso(x.occurredAt);
const copy=x=>JSON.parse(JSON.stringify(x));
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const digest=okxDataDigest;
const owner=s=>typeof process.getuid!=='function'||s.uid===process.getuid();
const validOrder=(order,map)=>order===undefined||Array.isArray(order)&&order.length===Object.keys(map).length&&new Set(order).size===order.length&&order.every(k=>typeof k==='string'&&Object.hasOwn(map,k));
function appendFifo(map,key,value,order=Object.keys(map)){
  const keys=[...order.filter(k=>k!==key),key].slice(-2048);
  return {map:Object.fromEntries(keys.map(k=>[k,k===key?value:map[k]])),order:keys};
}

/** Device assertions are private cached facts, not independent Host verification of OKX. */
export function createDeviceSourceGateway({dir,journal,now=Date.now}={}) {
  if(typeof dir!=='string'||!dir||typeof now!=='function'||!journal||!['recordVerifiedState','prepareAbsent','commitAbsent'].every(k=>typeof journal[k]==='function'))fail('invalid_request');
  const root=resolve(dir);
  // Cloud (multi-user) form is decided once at creation from users.json in the parent state
  // directory — the same determination agent-host makes; no runtime switch (docs/cloud-security-hardening.md §3.5).
  const cloud=existsSync(join(root,'..','users.json'));
  function clock(){const n=Number(now());if(!Number.isFinite(n)||!Number.isFinite(new Date(n).getTime()))fail('invalid_request');return n;}
  function scope(userId,goalId){if(!validId(userId??'')||!validId(goalId??''))fail('invalid_request');return join(root,hash([userId,goalId,'okx'])+'.json');}
  function directory(){mkdirSync(root,{recursive:true,mode:0o700});const s=lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink()||!owner(s))fail('storage_unavailable');chmodSync(root,0o700);}
  function validMetadata(m,r){return exact(m,['connectionId','version','state','observedAt','digest','capabilities'])&&m.connectionId===r.grantId&&Number.isSafeInteger(m.version)&&m.version>0&&m.version===r.sequence&&['ready','disconnected','revoked','unavailable'].includes(m.state)&&iso(m.observedAt)&&(m.state!=='ready'||typeof m.digest==='string'&&/^[a-f0-9]{64}$/.test(m.digest))&&
    (m.capabilities===undefined||['["trading_account_summary"]','["trading_account_summary","trading_history"]'].includes(JSON.stringify(m.capabilities)));}
  function validRecord(r,userId,goalId){
    return r?.version===1&&r.userId===userId&&r.goalId===goalId&&validId(r.deviceId??'')&&GRANT.test(r.grantId??'')&&['pending','connected','disconnected'].includes(r.state)&&Number.isSafeInteger(r.sequence)&&r.sequence>=0&&
      object(r.opens)&&Object.keys(r.opens).length<=2048&&Object.entries(r.opens).every(([id,o])=>validId(id)&&exact(o,['grantId','deviceId'])&&GRANT.test(o.grantId??'')&&validId(o.deviceId??''))&&
      object(r.events)&&Object.keys(r.events).length<=2048&&Object.entries(r.events).every(([id,e])=>validId(id)&&exact(e,['hash'])&&/^[a-f0-9]{64}$/.test(e.hash??''))&&
      validOrder(r.openOrder,r.opens)&&validOrder(r.eventOrder,r.events)&&
      (r.sourceStamp===null||stamp(r.sourceStamp))&&['pending','accepted','stale'].includes(r.admission)&&r.provenance==='ios-native-device-report'&&
      (r.metadata===null?r.state==='pending':validMetadata(r.metadata,r))&&
      // Cloud reads fail closed on stored history (e.g. a mis-migrated Mac record): treated
      // like a corrupt record instead of silently dropping the field.
      (r.history===undefined||(!cloud&&validOkxHistory(r.history,r.observedAt)))&&
      (r.state!=='connected'||r.metadata?.state==='ready'&&validSummary(r.summary)&&digest(r.summary,r.history)===r.metadata.digest&&iso(r.observedAt)&&r.observedAt===r.metadata.observedAt&&r.permission==='read_only'&&
        (r.metadata.capabilities===undefined&&!r.history||JSON.stringify(r.metadata.capabilities)===JSON.stringify(hasOkxHistory(r.history)?['trading_account_summary','trading_history']:['trading_account_summary'])));
  }
  function read(userId,goalId){let fd;try{directory();fd=openSync(scope(userId,goalId),constants.O_RDONLY|constants.O_NOFOLLOW);const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||!owner(s)||(s.mode&0o077)!==0||s.size>16*1024*1024)fail('storage_unavailable');const r=JSON.parse(readFileSync(fd,'utf8'));if(!validRecord(r,userId,goalId))fail('storage_unavailable');return r;}catch(e){if(e?.code==='ENOENT')return null;if(e instanceof DeviceSourceError)throw e;fail('storage_unavailable');}finally{if(fd!==undefined)closeSync(fd);}}
  function write(r){
    let fd,tmp;
    try{
      directory();const target=scope(r.userId,r.goalId);
      try{const s=lstatSync(target);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||!owner(s)||(s.mode&0o077)!==0)fail('storage_unavailable');}catch(e){if(e?.code!=='ENOENT')throw e;}
      tmp=join(root,randomBytes(20).toString('hex')+'.tmp');
      fd=openSync(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      writeFileSync(fd,JSON.stringify(r));fsyncSync(fd);closeSync(fd);fd=undefined;
      renameSync(tmp,target);tmp=undefined;
      fd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      fsyncSync(fd);closeSync(fd);fd=undefined;
    }catch(e){if(e instanceof DeviceSourceError)throw e;fail('storage_unavailable');}
    finally{if(fd!==undefined)closeSync(fd);if(tmp)try{unlinkSync(tmp);}catch{}}
  }
  function serial(userId,goalId,fn){const key=scope(userId,goalId),prior=QUEUES.get(key)??Promise.resolve();const job=prior.catch(()=>{}).then(fn).catch(e=>{if(e instanceof DeviceSourceError)throw e;fail('storage_unavailable');});QUEUES.set(key,job);return job.finally(()=>{if(QUEUES.get(key)===job)QUEUES.delete(key);});}
  async function authorized(check){if(check&&!(await check()))fail('stale_authorization');}
  function recover(r){
    if(!r)return r;
    if(!r.metadata){
      if(r.sourceStamp)journal.commitAbsent({userId:r.userId,goalId:r.goalId,stamp:r.sourceStamp});
      return r;
    }
    const result=journal.recordVerifiedState({userId:r.userId,deviceId:r.deviceId},r.goalId,'okx',r.metadata);
    if(!['accepted','duplicate','stale'].includes(result?.status))fail('storage_unavailable');
    const next={...r};
    if(result.status==='stale'){
      next.admission='stale';next.sourceStamp=null;next.state='disconnected';
      delete next.summary;delete next.history;delete next.observedAt;delete next.permission;
    }else{
      if(result.state!==r.metadata.state||!stamp(result.sourceStamp))fail('storage_unavailable');
      next.admission='accepted';next.sourceStamp=result.sourceStamp;
    }
    if(JSON.stringify(next)!==JSON.stringify(r))write(next);
    return next;
  }
  const view=r=>!r?{provider:'okx',state:'disconnected'}:{provider:'okx',state:r.state,grantId:r.grantId,...(r.state==='connected'?{lastSyncedAt:r.observedAt,summary:{...r.summary}}:{})};
  function inputFor(input,goalId,internal){
    if(!object(input)||!['context','open','publish','disconnect','status'].includes(input.action))fail('invalid_request');
    if(internal){if(!exact(input,['action'])||input.action!=='disconnect')fail('invalid_request');return input;}
    const keys=['action','provider','goalId',...(['open','status'].includes(input.action)?['requestId']:[]),...(input.action==='open'?['expectedGrantId']:[]),...(['publish','disconnect'].includes(input.action)?['grantId','eventId','sequence']:[]),...(input.action==='publish'?['observedAt','permission','summary','history']:[])];
    if(!exact(input,keys)||input.provider!=='okx'||input.goalId!==undefined&&input.goalId!==goalId)fail('invalid_request');
    if(input.action==='open'&&!validId(input.requestId??''))fail('invalid_request');
    if(input.action==='open'&&(!Object.hasOwn(input,'expectedGrantId')||input.expectedGrantId!==null&&(typeof input.expectedGrantId!=='string'||!GRANT.test(input.expectedGrantId))))fail('invalid_request');
    if(input.action==='status'&&input.requestId!==undefined&&!validId(input.requestId))fail('invalid_request');
    if(['publish','disconnect'].includes(input.action)&&(!GRANT.test(input.grantId??'')||!validId(input.eventId??'')||!Number.isSafeInteger(input.sequence)||input.sequence<1))fail('invalid_request');
    // Cloud accepts the three-field summary only: any publish carrying a history key is refused
    // outright (history is atomic with the summary digest, so stripping it is not possible).
    if(input.action==='publish'&&cloud&&Object.hasOwn(input,'history'))fail('invalid_request');
    if(input.action==='publish'&&(!iso(input.observedAt)||Date.parse(input.observedAt)>clock()+300000||input.permission!=='read_only'||!validSummary(input.summary)||Object.hasOwn(input,'history')&&!validOkxHistory(input.history,input.observedAt)))fail('invalid_request');
    return copy(input);
  }
  function fingerprint(input){const data=[input.action,input.provider,input.grantId,input.eventId,input.sequence,input.observedAt??null,input.permission??null,input.summary?[input.summary.tradingEquityUsd,input.summary.assetCount,input.summary.positionCount]:null];if(input.history!==undefined)data.push(digest(input.summary,input.history));return hash(data);}
  async function absent(r,{sourceState='disconnected',stillAuthorized,revokeIf,sequence}={}){
    if(revokeIf&&!(await revokeIf()))return r;
    await authorized(stillAuthorized);
    const version=sequence??r.sequence+1;
    if(!Number.isSafeInteger(version)||version<1)fail('invalid_request');
    const metadata={connectionId:r.grantId,version,state:sourceState,observedAt:new Date(clock()).toISOString()};
    const next={...r,sequence:version,state:'disconnected',sourceStamp:null,metadata,admission:'pending',provenance:'ios-native-device-report'};
    delete next.summary;delete next.history;delete next.observedAt;delete next.permission;
    write(next);return recover(next);
  }
  return {
    hasScope(args,goal){const a=typeof args==='string'?{userId:args,goalId:goal}:args;return read(a.userId,a.goalId)!==null;},
    owned(args,goal,device){const a=typeof args==='string'?{userId:args,goalId:goal,deviceId:device}:args;const r=read(a.userId,a.goalId);return !!r&&(a.deviceId===undefined||r.deviceId===a.deviceId);},
    async sourceSnapshot({userId,deviceId,goalId,stillAuthorized}){return serial(userId,goalId,async()=>{await authorized(stillAuthorized);let r=read(userId,goalId);if(!validId(deviceId??'')||r?.deviceId!==deviceId)return null;r=recover(r);await authorized(stillAuthorized);return r?.state==='connected'&&r.admission==='accepted'?copy({metadata:r.metadata,summary:r.summary,...(r.history?{history:r.history}:{}),observedAt:r.observedAt,sourceStamp:r.sourceStamp}):null;});},
    async handle({userId,deviceId,goalId,input,stillAuthorized,sourceState,revokeIf}){
      const internal=deviceId===undefined&&input?.action==='disconnect'&&(sourceState!==undefined||typeof revokeIf==='function');
      if(!internal&&!validId(deviceId??''))fail('invalid_request');
      const command=inputFor(input,goalId,internal);
      return serial(userId,goalId,async()=>{
        await authorized(stillAuthorized);let r=read(userId,goalId);r=recover(r);
        if(internal){if(!r)return null;if(sourceState!==undefined&&!['disconnected','revoked','unavailable'].includes(sourceState))fail('invalid_request');return view(await absent(r,{sourceState,stillAuthorized,revokeIf}));}
        if(command.action==='context')return {userId,deviceId,goalId,provider:'okx',currentGrantId:r?.grantId??null};
        if(command.action==='status'){
          if(command.requestId!==undefined){
            const intent=r&&Object.hasOwn(r.opens,command.requestId)?r.opens[command.requestId]:undefined;
            if(!intent||intent.deviceId!==deviceId||r.deviceId!==deviceId)return {provider:'okx',state:'disconnected'};
            return intent.grantId===r.grantId?view(r):{provider:'okx',state:'disconnected',grantId:intent.grantId};
          }
          return r?.deviceId===deviceId?view(r):{provider:'okx',state:'disconnected'};
        }
        if(command.action==='open'){
          const prior=r&&Object.hasOwn(r.opens,command.requestId)?r.opens[command.requestId]:undefined;
          if(prior){
            if(prior.deviceId!==deviceId)fail('stale_authorization');
            return {...(prior.grantId===r.grantId?view(r):{provider:'okx',state:'disconnected',grantId:prior.grantId}),userId,deviceId,goalId};
          }
          if(command.expectedGrantId!==(r?.grantId??null))fail('stale_authorization');
          const s=journal.prepareAbsent({userId,goalId,state:'disconnected'});
          const sourceStamp={generation:s.generation,revision:s.revision,reference:s.reference,occurredAt:s.occurredAt};
          if(!stamp(sourceStamp))fail('storage_unavailable');
          await authorized(stillAuthorized);
          const grantId=randomBytes(32).toString('hex');
          const history=appendFifo(r?.opens??{},command.requestId,{grantId,deviceId},r?.openOrder);
          const next={version:1,userId,deviceId,goalId,grantId,state:'pending',sequence:0,events:{},eventOrder:[],opens:history.map,openOrder:history.order,sourceStamp,metadata:null,admission:'accepted',provenance:'ios-native-device-report'};
          write(next); // Persist the replacement grant before publishing its disconnected source epoch.
          journal.commitAbsent({userId,goalId,stamp:s});
          return {...view(next),userId,deviceId,goalId};
        }
        const receipt=status=>({event_id:command.eventId,status});
        if(!r||r.deviceId!==deviceId||r.grantId!==command.grantId)return receipt('stale');
        if(r.admission==='stale'&&r.metadata?.state==='ready')return receipt('stale');
        const fp=fingerprint(command),previous=Object.hasOwn(r.events,command.eventId)?r.events[command.eventId]:undefined;
        if(previous){if(previous.hash!==fp)fail('event_conflict');return receipt('duplicate');}
        if(command.sequence<=r.sequence||r.state==='disconnected')return receipt('stale');
        const history=appendFifo(r.events,command.eventId,{hash:fp},r.eventOrder);
        const next={...r,sequence:command.sequence,events:history.map,eventOrder:history.order};
        if(command.action==='disconnect'){
          await absent(next,{stillAuthorized,sequence:command.sequence});return receipt('accepted');
        }
        await authorized(stillAuthorized);
        const metadata={connectionId:r.grantId,version:command.sequence,state:'ready',observedAt:command.observedAt,digest:digest(command.summary,command.history),...(command.history?{capabilities:hasOkxHistory(command.history)?['trading_account_summary','trading_history']:['trading_account_summary']}: {})};
        if(command.history)next.history=copy(command.history);else delete next.history;
        Object.assign(next,{state:'connected',summary:{...command.summary},observedAt:command.observedAt,sourceStamp:null,metadata,admission:'pending',permission:'read_only',provenance:'ios-native-device-report'});
        write(next); // An admitted native fact is durable before it can enter the common source journal.
        const admitted=recover(next);
        if(admitted.admission==='stale')return receipt('stale');
        return receipt('accepted');
      });
    },
  };
}
