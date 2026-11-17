import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes} from 'node:crypto';
import {constants,openSync,closeSync,readFileSync,writeFileSync,mkdirSync,lstatSync,fstatSync,chmodSync,renameSync,unlinkSync,fsyncSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {sourceDigest,validSourceStamp} from './source-event-bridge.mjs';

// URLs and verbs are intentionally not caller-configurable. No trading/funding write endpoint exists here.
const SITES=Object.freeze({global:'https://openapi.okx.com',eea:'https://eea.okx.com',us:'https://us.okx.com'});
const PATHS=new Set(['/api/v5/public/time','/api/v5/account/config','/api/v5/account/balance','/api/v5/account/positions']);
const QUEUES=new Map();
const MESSAGES=Object.freeze({
  invalid_request:'OKX 连接请求无效。',invalid_credentials:'请完整填写 OKX API 凭证。',
  not_connected:'此目标尚未连接 OKX。',permission_denied:'仅支持只读 API Key，请关闭交易和提现权限后重试。',
  api_rejected:'OKX 未接受请求，请检查凭证、所属站点及 IP 白名单。',
  network_error:'暂时无法连接 OKX，请稍后重试。',timeout:'OKX 请求超时，请稍后重试。',
  invalid_response:'OKX 返回的数据无法验证，请稍后重试。',
  vault_unavailable:'本机 OKX 凭证存储不可用，请检查后重试。',
  stale_authorization:'目标或配对已变化，本次连接未保存。',
});
export class OkxConnectionError extends Error {
  constructor(code){super(MESSAGES[code]??MESSAGES.network_error);this.name='OkxConnectionError';this.code=Object.hasOwn(MESSAGES,code)?code:'network_error';}
}
const fail=code=>{throw new OkxConnectionError(code);};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).every(key=>keys.includes(key));
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const decimal=value=>typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value)&&Number.isFinite(Number(value));
const disconnected=()=>({provider:'okx',state:'disconnected'});
const connected=value=>({provider:'okx',state:'connected',lastSyncedAt:value.lastSyncedAt,summary:{...value.summary}});
function credentials(value){
  if(!exact(value,['apiKey','secretKey','passphrase'])||Object.keys(value).length!==3)fail('invalid_credentials');
  const clean={};
  for(const key of ['apiKey','secretKey','passphrase']){
    const text=value[key];
    // Header injection, accidental whitespace and oversized inputs fail before any request or persistence.
    if(typeof text!=='string'||text.length<1||text.length>256||!/^\S+$/.test(text)||/[\x00-\x20\x7f]/.test(text))fail('invalid_credentials');
    clean[key]=text;
  }
  return clean;
}
function requestInput(input){
  if(!record(input)||!['status','connect','refresh','disconnect'].includes(input.action))fail('invalid_request');
  if(input.action!=='connect'){
    if(!exact(input,['action']))fail('invalid_request');
    return {action:input.action};
  }
  if(!exact(input,['action','site','credentials'])||!Object.hasOwn(SITES,input.site))fail('invalid_request');
  return {action:'connect',site:input.site,credentials:credentials(input.credentials)};
}
function summary(value){
  return exact(value,['tradingEquityUsd','assetCount','positionCount'])&&Object.keys(value).length===3&&
    Number.isFinite(value.tradingEquityUsd)&&Number.isSafeInteger(value.assetCount)&&value.assetCount>=0&&
    Number.isSafeInteger(value.positionCount)&&value.positionCount>=0;
}

/** One Host-owned encrypted vault. Target ownership/recommendation is checked by the authenticated caller. */
export function createOkxConnection({dir,fetchImpl=fetch,now=Date.now,timeoutMs=10_000,maxBytes=512*1024,sourceJournal=null}={}){
  if(typeof dir!=='string'||!dir||typeof fetchImpl!=='function'||typeof now!=='function'||
      !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>2*1024*1024)fail('invalid_request');
  const root=resolve(dir),master=join(root,'master.key');
  const localNow=()=>{const n=Number(now());if(!Number.isFinite(n)||!Number.isFinite(new Date(n).getTime()))fail('invalid_response');return n;};
  const owner=stat=>typeof process.getuid!=='function'||stat.uid===process.getuid();
  function directory(){
    mkdirSync(root,{recursive:true,mode:0o700});
    const stat=lstatSync(root);
    if(!stat.isDirectory()||stat.isSymbolicLink()||!owner(stat))fail('vault_unavailable');
    chmodSync(root,0o700);
  }
  function privateRead(path,limit){
    let fd;
    try{
      fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=fstatSync(fd);
      if(!stat.isFile()||stat.nlink!==1||!owner(stat)||(stat.mode&0o077)!==0||stat.size>limit)fail('vault_unavailable');
      return readFileSync(fd);
    }finally{if(fd!==undefined)closeSync(fd);}
  }
  function masterKey(create){
    try{return privateRead(master,32);}catch(error){
      if(error?.code!=='ENOENT'||!create)throw error;
      // Losing a master key must never silently replace the key protecting an existing vault.
      if(readdirSync(root).some(name=>/^[0-9a-f]{64}\.json$/.test(name)))fail('vault_unavailable');
      let fd;const key=randomBytes(32);
      try{fd=openSync(master,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,key);fsyncSync(fd);}
      catch(error){if(error?.code!=='EEXIST')throw error;}
      finally{key.fill(0);if(fd!==undefined)closeSync(fd);}
      return privateRead(master,32);
    }
  }
  function load(key,userId,goalId){
    let encrypted;
    try{encrypted=privateRead(join(root,key+'.json'),64*1024);}catch(error){if(error?.code==='ENOENT')return null;throw error;}
    const envelope=JSON.parse(encrypted.toString('utf8'));
    if(!exact(envelope,['version','iv','tag','ciphertext'])||envelope.version!==1||
      ![envelope.iv,envelope.tag,envelope.ciphertext].every(value=>typeof value==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(value)))fail('vault_unavailable');
    const secret=masterKey(false);let plain;
    try{
      if(secret.length!==32)fail('vault_unavailable');
      const iv=Buffer.from(envelope.iv,'base64'),tag=Buffer.from(envelope.tag,'base64');
      if(iv.length!==12||tag.length!==16)fail('vault_unavailable');
      const decipher=createDecipheriv('aes-256-gcm',secret,iv);decipher.setAAD(Buffer.from('along-okx-v1:'+key));decipher.setAuthTag(tag);
      plain=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);
      const value=JSON.parse(plain.toString('utf8'));
      if(!record(value)||value.version!==1||value.userId!==userId||value.goalId!==goalId||!Object.hasOwn(SITES,value.site)||
          typeof value.lastSyncedAt!=='string'||!Number.isFinite(Date.parse(value.lastSyncedAt))||!summary(value.summary))fail('vault_unavailable');
      if(value.sourceStamp!==undefined&&!validSourceStamp(value.sourceStamp))fail('vault_unavailable');
      value.credentials=credentials(value.credentials);
      return value;
    }finally{secret.fill(0);plain?.fill(0);}
  }
  function save(key,value){
    const secret=masterKey(true),iv=randomBytes(12),plain=Buffer.from(JSON.stringify(value));let fd,path;
    try{
      if(secret.length!==32)fail('vault_unavailable');
      const cipher=createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(Buffer.from('along-okx-v1:'+key));
      const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
      const sealed=JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')});
      path=join(root,key+'.'+randomBytes(8).toString('hex')+'.tmp');
      fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      writeFileSync(fd,sealed);fsyncSync(fd);closeSync(fd);fd=undefined;
      renameSync(path,join(root,key+'.json'));path=undefined;
    }finally{secret.fill(0);plain.fill(0);if(fd!==undefined)closeSync(fd);if(path)try{unlinkSync(path);}catch{}}
  }
  async function request(site,path,credential,offset=0){
    if(!Object.hasOwn(SITES,site)||!PATHS.has(path))fail('invalid_request');
    const controller=new AbortController();let timer,timeoutReader;
    const run=async()=>{
      const headers={Accept:'application/json'};
      if(credential){
        const timestamp=new Date(localNow()+offset).toISOString();
        headers['OK-ACCESS-KEY']=credential.apiKey;headers['OK-ACCESS-PASSPHRASE']=credential.passphrase;
        headers['OK-ACCESS-TIMESTAMP']=timestamp;
        headers['OK-ACCESS-SIGN']=createHmac('sha256',credential.secretKey).update(timestamp+'GET'+path).digest('base64');
      }
      const url=SITES[site]+path,response=await fetchImpl(url,{method:'GET',headers,redirect:'error',signal:controller.signal});
      if(!response||response.redirected||response.url&&response.url!==url)fail('invalid_response');
      if(!response.ok){void response.body?.cancel?.().catch(()=>{});fail('api_rejected');}
      const declared=response.headers?.get?.('content-length');
      if(declared!==null&&declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes))fail('invalid_response');
      if(!response.body?.getReader)fail('invalid_response');
      const reader=response.body.getReader(),chunks=[];timeoutReader=reader;let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;
        if(!(value instanceof Uint8Array))fail('invalid_response');size+=value.byteLength;
        if(size>maxBytes){void reader.cancel().catch(()=>{});fail('invalid_response');}chunks.push(value);
      }}finally{reader.releaseLock();}
      let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid_response');}
      if(!record(data)||typeof data.code!=='string'||data.code!=='0'||!Array.isArray(data.data))fail(data?.code==='0'?'invalid_response':'api_rejected');
      return data.data;
    };
    try{return await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();void timeoutReader?.cancel().catch(()=>{});reject(new OkxConnectionError('timeout'));},timeoutMs);})]);}
    catch(error){if(error instanceof OkxConnectionError)throw error;throw new OkxConnectionError(controller.signal.aborted?'timeout':'network_error');}
    finally{clearTimeout(timer);controller.abort();}
  }
  async function sync(site,credential){
    const time=await request(site,'/api/v5/public/time');
    if(time.length!==1||typeof time[0]?.ts!=='string'||!/^\d{13}$/.test(time[0].ts))fail('invalid_response');
    const server=Number(time[0].ts);if(!Number.isFinite(new Date(server).getTime()))fail('invalid_response');
    const offset=server-localNow(),config=await request(site,'/api/v5/account/config',credential,offset);
    if(config.length!==1||config[0]?.perm!=='read_only')fail('permission_denied');
    const balance=await request(site,'/api/v5/account/balance',credential,offset);
    if(balance.length!==1||!decimal(balance[0]?.totalEq)||!Array.isArray(balance[0].details)||
        balance[0].details.some(asset=>!record(asset)||typeof asset.ccy!=='string'||!/^[A-Z0-9]{1,24}$/.test(asset.ccy))||
        new Set(balance[0].details.map(asset=>asset.ccy)).size!==balance[0].details.length)fail('invalid_response');
    const positions=await request(site,'/api/v5/account/positions',credential,offset);
    if(positions.some(position=>!record(position)||!decimal(position.pos)))fail('invalid_response');
    return {lastSyncedAt:new Date(localNow()).toISOString(),summary:{tradingEquityUsd:Number(balance[0].totalEq),
      assetCount:balance[0].details.length,positionCount:positions.filter(position=>Number(position.pos)!==0).length}};
  }
  async function authorized(check){
    if(check===undefined)return;
    try{if(typeof check!=='function'||await check()!==true)fail('stale_authorization');}
    catch{fail('stale_authorization');}
  }
  function serialized(key,run){
    const queueKey=root+':'+key,operation=(QUEUES.get(queueKey)??Promise.resolve()).catch(()=>{}).then(run);
    QUEUES.set(queueKey,operation);const clear=()=>{if(QUEUES.get(queueKey)===operation)QUEUES.delete(queueKey);};operation.then(clear,clear);return operation;
  }
  const sourceFailed=()=>{}; // Reservations remain durable; the bounded Host pump reconciles a later commit failure.
  return {
  hasSavedSource({userId,goalId}={}){if(!identity(userId)||!identity(goalId))fail('invalid_request');try{directory();return !!lstatSync(join(root,createHash('sha256').update(JSON.stringify([userId,goalId])).digest('hex')+'.json'));}catch(e){if(e?.code==='ENOENT')return false;throw e;}},
  async sourceSnapshot({userId,goalId,stillAuthorized}={}){
    if(!identity(userId)||!identity(goalId)||typeof stillAuthorized!=='function')fail('invalid_request');
    const key=createHash('sha256').update(JSON.stringify([userId,goalId])).digest('hex');
    return serialized(key,async()=>{
      await authorized(stillAuthorized);directory();let saved;
      try{saved=load(key,userId,goalId);}catch{
        if(sourceJournal)try{const stamp=sourceJournal.prepareAbsent({userId,goalId,state:'unavailable'});sourceJournal.commitAbsent({userId,goalId,stamp});}catch{}
        fail('vault_unavailable');
      }
      await authorized(stillAuthorized);
      if(!saved){
        if(sourceJournal){sourceJournal.recover({userId,goalId,missing:true});if(sourceJournal.current(userId,goalId)?.state==='ready'){const stamp=sourceJournal.prepareAbsent({userId,goalId,state:'unavailable'});sourceJournal.commitAbsent({userId,goalId,stamp});}}
        return null;
      }
      if(sourceJournal){
        const digest=sourceDigest(saved.summary);
        if(!saved.sourceStamp){const stamp=sourceJournal.prepareReady({userId,goalId,operation:'adopt',digest});save(key,{...saved,sourceStamp:stamp});saved.sourceStamp=stamp;}
        sourceJournal.recover({userId,goalId,stamp:saved.sourceStamp,digest});
      }
      return {provider:'okx',observedAt:saved.lastSyncedAt,summary:{...saved.summary},...(saved.sourceStamp?{sourceStamp:{...saved.sourceStamp}}:{})};
    });
  },
  async handle(context={}){
    if(!record(context))fail('invalid_request');
    const {userId,goalId,input,stillAuthorized,revokeIf,sourceState='disconnected'}=context;
    if(!['disconnected','revoked'].includes(sourceState))fail('invalid_request');
    if(!identity(userId)||!identity(goalId))fail('invalid_request');
    const command=requestInput(input),key=createHash('sha256').update(JSON.stringify([userId,goalId])).digest('hex');
    return serialized(key,async()=>{
      await authorized(stillAuthorized);
      try{directory();}catch{fail('vault_unavailable');}
      let saved;
      if(command.action==='status'||command.action==='refresh'){
        try{saved=load(key,userId,goalId);}catch{fail('vault_unavailable');}
      }
      if(command.action==='status'){await authorized(stillAuthorized);return saved?connected(saved):disconnected();}
      if(command.action==='disconnect'){
        if(revokeIf!==undefined){
          if(typeof revokeIf!=='function')fail('invalid_request');
          if(await revokeIf()!==true)return null; // Internal conditional cleanup, not a public action.
        }
        await authorized(stillAuthorized);
        let hadSaved=false;try{hadSaved=!!lstatSync(join(root,key+'.json'));}catch(error){if(error?.code!=='ENOENT')fail('vault_unavailable');}
        let stamp;
        if(sourceJournal)try{if(!hadSaved)sourceJournal.recover({userId,goalId,missing:true});if(hadSaved||sourceJournal.current(userId,goalId))stamp=sourceJournal.prepareAbsent({userId,goalId,state:sourceState});}catch{fail('vault_unavailable');}
        try{unlinkSync(join(root,key+'.json'));}catch(error){if(error?.code!=='ENOENT')fail('vault_unavailable');}
        if(stamp)try{sourceJournal.commitAbsent({userId,goalId,stamp});}catch{sourceFailed();}
        return disconnected();
      }
      if(command.action==='refresh'&&!saved)fail('not_connected');
      const site=command.action==='connect'?command.site:saved.site,credential=command.action==='connect'?command.credentials:saved.credentials;
      const current=await sync(site,credential);
      await authorized(stillAuthorized);
      let sourceStamp;
      if(sourceJournal)try{sourceStamp=sourceJournal.prepareReady({userId,goalId,operation:command.action,digest:sourceDigest(current.summary),priorStamp:saved?.sourceStamp});}catch{fail('vault_unavailable');}
      try{save(key,{version:1,userId,goalId,site,credentials:credential,...current,...(sourceStamp?{sourceStamp}:{})});}catch{fail('vault_unavailable');}
      if(sourceStamp)try{sourceJournal.commitSaved({userId,goalId,stamp:sourceStamp,digest:sourceDigest(current.summary)});}catch{sourceFailed();}
      return connected(current);
    });
  }};
}
