import {constants,createHash,createPrivateKey,sign,X509Certificate} from 'node:crypto';
import {constants as fsConstants,openSync,closeSync,fsyncSync,fstatSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const HANDOFF_PURPOSE='along-personal-workspace-handoff/v1';
export const HANDOFF_FIELDS=['purpose','migrationId','sourceOrigin','targetOrigin','userId','deviceId',
  'sourceCredentialSHA256','targetCredentialSHA256','manifestSHA256','importReceiptSHA256','snapshotSHA256','syncPrefixSHA256',
  'syncHighWaterMark','activationPermitSHA256','sourcePhase','nonce','issuedAt','expiresAt'];
const hash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
export const handoffDigest=value=>createHash('sha256').update(value).digest('hex');
export function expectedHandoffHolds(manifest) {
  if(!Array.isArray(manifest.sourceHolds))throw Error('交接manifest缺少来源hold清单');
  return manifest.sourceHolds.map(hold=>{
    const fields=['provider','goalId','reason','sourceEventId','sourceGeneration','sourceRevision'];
    if(!hold||Object.keys(hold).sort().join('|')!==fields.sort().join('|')||hold.provider!=='okx'||
      hold.reason!=='cloud_history_unsupported'||!manifest.goalIds.includes(hold.goalId)||typeof hold.sourceEventId!=='string'||
      !Number.isSafeInteger(hold.sourceGeneration)||hold.sourceGeneration<1||!Number.isSafeInteger(hold.sourceRevision)||
      hold.sourceRevision<1||hold.sourceRevision>=Number.MAX_SAFE_INTEGER)throw Error('交接来源hold无效');
    return {...hold,eventId:'handoff_hold_'+handoffDigest(canonicalHandoffJSON([manifest.migrationId,hold])).slice(0,40),
      generation:hold.sourceGeneration,revision:hold.sourceRevision+1,state:'unavailable'};
  });
}
export function validateHandoffTargetReceipt(manifest,receipt) {
  if(!receipt||Object.keys(receipt).sort().join('|')!=='snapshotSHA256|sourceHolds|syncHighWaterMark'||!hash(receipt.snapshotSHA256)||
    !Number.isSafeInteger(receipt.syncHighWaterMark)||receipt.syncHighWaterMark<manifest.syncHighWaterMark||
    canonicalHandoffJSON(receipt.sourceHolds)!==canonicalHandoffJSON(expectedHandoffHolds(manifest))||
    !manifest.sourceHolds.length&&(receipt.snapshotSHA256!==manifest.snapshotSHA256||receipt.syncHighWaterMark!==manifest.syncHighWaterMark))
    throw Error('云端来源hold回执不匹配');
  return receipt;
}
export function canonicalHandoffJSON(value) {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isSafeInteger(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonicalHandoffJSON).join(',')+']';
  if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)
    return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalHandoffJSON(value[key])).join(',')+'}';
  throw Error('交接数据不是受支持的规范JSON');
}
export function canonicalHandoffOrigin(value) {
  if(typeof value!=='string'||value.length>250||!/^[\x21-\x7e]+$/.test(value))throw Error('交接地址无效');
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==value)
    throw Error('交接地址必须是规范HTTPS origin');
  return url.origin;
}
export function validateHandoffClaims(c,now=Math.floor(Date.now()/1000),{allowExpired=false}={}) {
  if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).sort().join('|')!==[...HANDOFF_FIELDS].sort().join('|')||
    HANDOFF_FIELDS.some(k=>typeof c[k]!=='string'||c[k].length>250||/[\r\n\x00-\x20\x7f-\uffff]/.test(c[k]))||
    c.purpose!==HANDOFF_PURPOSE||!/^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/.test(c.migrationId)||
    !/^u_[0-9a-f]{8}$/.test(c.userId)||!/^d_[0-9a-f]{8}$/.test(c.deviceId)||c.sourcePhase!=='source_retired'||
    ['sourceCredentialSHA256','targetCredentialSHA256','manifestSHA256','importReceiptSHA256','snapshotSHA256','syncPrefixSHA256','activationPermitSHA256','nonce'].some(k=>!hash(c[k]))||
    !/^(?:0|[1-9][0-9]{0,15})$/.test(c.syncHighWaterMark)||!Number.isSafeInteger(Number(c.syncHighWaterMark))||
    !/^[1-9][0-9]{8,10}$/.test(c.issuedAt)||!/^[1-9][0-9]{8,10}$/.test(c.expiresAt)||
    Number(c.expiresAt)<=Number(c.issuedAt)||Number(c.expiresAt)-Number(c.issuedAt)>900||
    Number(c.issuedAt)>now+30||(!allowExpired&&Number(c.expiresAt)<=now))throw Error('交接证明字段无效或已过期');
  canonicalHandoffOrigin(c.sourceOrigin);canonicalHandoffOrigin(c.targetOrigin);
  if(c.sourceOrigin===c.targetOrigin||c.sourceCredentialSHA256===c.targetCredentialSHA256)throw Error('交接目标地址和凭据必须独立');
  return c;
}
// Fixed ASCII fields in a fixed order, one value per line. This is deliberately not JSON.stringify
// on the phone: Foundation and JavaScript need not agree on key ordering or slash escaping.
export function handoffSigningBytes(claims,now) {
  validateHandoffClaims(claims,now);
  return Buffer.from(HANDOFF_FIELDS.map(k=>k+'='+claims[k]).join('\n')+'\n','utf8');
}
export function signWorkspaceHandoff(claims,{certificatePEM,privateKeyPEM,now=Math.floor(Date.now()/1000)}) {
  const certificate=new X509Certificate(certificatePEM),key=createPrivateKey(privateKeyPEM);
  if(key.asymmetricKeyType!=='rsa'||!certificate.checkPrivateKey(key)||
    Date.parse(certificate.validFrom)>now*1000||Date.parse(certificate.validTo)<=now*1000)
    throw Error('原Host签名证书或密钥不匹配/已失效');
  const signature=sign('sha256',handoffSigningBytes(claims,now),{key,padding:constants.RSA_PKCS1_PADDING});
  return {algorithm:'rsa-pkcs1-sha256',payload:handoffSigningBytes(claims,now).toString('utf8'),certificateDER:certificate.raw.toString('base64'),signature:signature.toString('base64')};
}
export function readPrivateHandoffJSON(file) {
  let fd;
  try {
    fd=openSync(file,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)||stat.size>256*1024||stat.uid!==process.getuid())
      throw Error('交接文件须为当前用户的私有普通文件');
    const text=readFileSync(fd,'utf8');
    try{return JSON.parse(text);}catch{throw Error('受保护交接文件不是有效JSON');}
  }finally{if(fd!==undefined)closeSync(fd);}
}
export function writePrivateHandoffJSON(file,value) {
  const temp=file+'.'+randomUUID();
  let fd;
  try {
    fd=openSync(temp,fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|fsConstants.O_NOFOLLOW,0o600);
    writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);closeSync(fd);fd=undefined;
    renameSync(temp,file);
    fd=openSync(dirname(file),fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW);
    fsyncSync(fd);closeSync(fd);fd=undefined;
  }catch(error){if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}throw error;}
}
export function readHostHandoffStatus(dir,who,{tokenHash}={}) {
  const file=join(dir,'personal-handoff.json');
  let state;
  try{state=readPrivateHandoffJSON(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const {claims,importReceiptSHA256,agentStateFile}=state;
  validateHandoffClaims(claims,undefined,{allowExpired:true});
  if(who.userId!==claims.userId||who.deviceId!==claims.deviceId||tokenHash!==claims.targetCredentialSHA256||!hash(importReceiptSHA256))
    return null;
  const agent=readPrivateHandoffJSON(agentStateFile),manifest=agent.manifest;
  if(agent.version!==1||!manifest||!['target_staged','target_active'].includes(agent.phase)||manifest.migrationId!==claims.migrationId||
    manifest.sourceUserId!==claims.userId||manifest.sourceDeviceId!==claims.deviceId||manifest.targetOrigin!==claims.targetOrigin||
    manifest.snapshotSHA256!==claims.snapshotSHA256||manifest.syncPrefixSHA256!==claims.syncPrefixSHA256||
    String(manifest.syncHighWaterMark)!==claims.syncHighWaterMark||manifest.activationPermitSHA256!==claims.activationPermitSHA256||
    handoffDigest(canonicalHandoffJSON(manifest))!==claims.manifestSHA256||importReceiptSHA256!==claims.importReceiptSHA256)
    throw Error('云交接状态与导入快照不一致');
  const targetReceipt=validateHandoffTargetReceipt(manifest,agent.targetReceipt);
  const companion=readPrivateHandoffJSON(join(dir,'personal-handoff-companion.json'));
  if(companion.format!=='along-host-companion-receipt/v1'||companion.migrationId!==claims.migrationId||
    companion.sourceUserId!==claims.userId||companion.sourceDeviceId!==claims.deviceId||companion.sourceCredentialSHA256!==claims.sourceCredentialSHA256||
    !hash(manifest.hostCompanionSHA256)||companion.hostCompanionSHA256!==manifest.hostCompanionSHA256)
    throw Error('云Host必要来源与通知账本尚未交接');
  if(typeof state.importReceiptUTF8!=='string'||handoffDigest(state.importReceiptUTF8)!==claims.importReceiptSHA256||
    canonicalHandoffJSON(JSON.parse(state.importReceiptUTF8).targetReceipt)!==canonicalHandoffJSON(targetReceipt))throw Error('云端导入回执已改变');
  return {purpose:HANDOFF_PURPOSE,migrationId:claims.migrationId,userId:claims.userId,deviceId:claims.deviceId,
    phase:agent.phase,manifestSHA256:claims.manifestSHA256,snapshotSHA256:claims.snapshotSHA256,
    syncPrefixSHA256:claims.syncPrefixSHA256,syncHighWaterMark:Number(claims.syncHighWaterMark),
    activationPermitSHA256:claims.activationPermitSHA256,hostCompanionSHA256:manifest.hostCompanionSHA256,importReceiptSHA256,importReceiptUTF8:state.importReceiptUTF8,eventProtocol:1,handoffReady:false};
}
export function runtimeHandoffMatches(status,witness) {
  const fields=['format','phase','migrationId','userId','deviceId','manifestSHA256','snapshotSHA256','syncPrefixSHA256','syncHighWaterMark','activationPermitSHA256','hostCompanionSHA256','sourceHolds','targetReceipt'];
  if(!witness||Object.keys(witness).sort().join('|')!==fields.sort().join('|')||witness.format!=='along-personal-handoff/source-status/v1'||witness.phase!=='target_active'||
    status.phase!=='target_active'||!['migrationId','userId','deviceId','manifestSHA256','snapshotSHA256','syncPrefixSHA256','activationPermitSHA256','hostCompanionSHA256']
      .every(k=>witness[k]===status[k])||witness.syncHighWaterMark!==status.syncHighWaterMark)return false;
  try {
    const imported=JSON.parse(status.importReceiptUTF8);
    return canonicalHandoffJSON(witness.targetReceipt)===canonicalHandoffJSON(imported.targetReceipt)&&
      canonicalHandoffJSON(witness.sourceHolds)===canonicalHandoffJSON(imported.targetReceipt.sourceHolds.map(
        ({eventId,generation,revision,state,...original})=>original));
  }catch{return false;}
}
