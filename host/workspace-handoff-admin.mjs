// Local, explicit operator tool only. No HTTP import/signing endpoint and no arbitrary SQL.
import {randomBytes} from 'node:crypto';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BINDING_TTL_MS,loadUsers,readPairings,savePairings,withPairingsLock} from './pairing.mjs';
import {HANDOFF_PURPOSE,canonicalHandoffJSON,canonicalHandoffOrigin,handoffDigest,readPrivateHandoffJSON,
  signWorkspaceHandoff,writePrivateHandoffJSON,expectedHandoffHolds,validateHandoffTargetReceipt} from './workspace-handoff.mjs';
import {exportHostCompanion,installHostCompanion} from './workspace-handoff-companion.mjs';

const manifestFields=['format','migrationId','sourceUserId','sourceDeviceId','schemaVersion','targetOrigin','createdAt','goalIds',
  'snapshotSHA256','syncPrefixSHA256','syncHighWaterMark','activationPermitSHA256','hostCompanionSHA256','sourceHolds','tables'];
const hash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
function keys(input,allowed) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join('|')!==[...allowed].sort().join('|'))
    throw Error('交接管理参数字段无效');
}
function protectedDirectory(dir) {
  const st=lstatSync(dir);
  if(!isAbsolute(dir)||!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)||st.uid!==process.getuid())throw Error('交接目录不是私有目录');
}
function manifestAt(file) {
  const m=readPrivateHandoffJSON(file);keys(m,manifestFields);
  if(m.format!=='along-personal-handoff/v1'||m.schemaVersion!==18||!/^u_[0-9a-f]{8}$/.test(m.sourceUserId)||
    !/^d_[0-9a-f]{8}$/.test(m.sourceDeviceId)||!Array.isArray(m.goalIds)||m.goalIds.length<1||!Array.isArray(m.tables)||
    !['snapshotSHA256','syncPrefixSHA256','activationPermitSHA256','hostCompanionSHA256'].every(k=>hash(m[k]))||
    !Number.isSafeInteger(m.syncHighWaterMark)||m.syncHighWaterMark<0)throw Error('Agent交接manifest无效');
  canonicalHandoffOrigin(m.targetOrigin);expectedHandoffHolds(m);return m;
}
function fenceAt(file,manifest,phases) {
  const s=readPrivateHandoffJSON(file);
  if(s.version!==1||!phases.includes(s.phase)||canonicalHandoffJSON(s.manifest)!==canonicalHandoffJSON(manifest))
    throw Error('Agent交接围栏未处于匹配阶段');
  return s;
}
function challengeAt(file,manifest,now) {
  const c=readPrivateHandoffJSON(file);
  keys(c,['purpose','sourceOrigin','targetOrigin','sourceFingerprint','sourceCredentialSHA256','userId','nonce','createdAt','expiresAt']);
  if(c.purpose!==HANDOFF_PURPOSE||c.userId!==manifest.sourceUserId||c.targetOrigin!==manifest.targetOrigin||
    !hash(c.sourceCredentialSHA256)||!hash(c.nonce)||typeof c.sourceFingerprint!=='string'||!hash(c.sourceFingerprint.toLowerCase())||
    !Number.isSafeInteger(c.createdAt)||!Number.isSafeInteger(c.expiresAt)||c.createdAt>now+30||c.expiresAt<=now||
    c.expiresAt-c.createdAt>86400)throw Error('原手机交接challenge无效或已过期');
  canonicalHandoffOrigin(c.sourceOrigin);return c;
}
function receiptFor(m,targetReceipt) {
  validateHandoffTargetReceipt(m,targetReceipt);
  return {format:'along-host-import-receipt/v1',manifestSHA256:handoffDigest(canonicalHandoffJSON(m)),phase:'target_staged',
    migrationId:m.migrationId,sourceUserId:m.sourceUserId,sourceDeviceId:m.sourceDeviceId,targetOrigin:m.targetOrigin,
    snapshotSHA256:m.snapshotSHA256,syncPrefixSHA256:m.syncPrefixSHA256,syncHighWaterMark:m.syncHighWaterMark,
    activationPermitSHA256:m.activationPermitSHA256,targetReceipt};
}
function claimsFor(m,c,token,receipt,now) {
  return {purpose:HANDOFF_PURPOSE,migrationId:m.migrationId,sourceOrigin:c.sourceOrigin,targetOrigin:m.targetOrigin,
    userId:m.sourceUserId,deviceId:m.sourceDeviceId,sourceCredentialSHA256:c.sourceCredentialSHA256,
    targetCredentialSHA256:handoffDigest(token),manifestSHA256:handoffDigest(canonicalHandoffJSON(m)),
    importReceiptSHA256:handoffDigest(canonicalHandoffJSON(receipt)),snapshotSHA256:m.snapshotSHA256,syncPrefixSHA256:m.syncPrefixSHA256,
    syncHighWaterMark:String(m.syncHighWaterMark),activationPermitSHA256:m.activationPermitSHA256,
    sourcePhase:'source_retired',nonce:c.nonce,issuedAt:String(now),expiresAt:String(Math.min(now+900,c.expiresAt))};
}
export async function stageTargetHandoff(config,now=Math.floor(Date.now()/1000)) {
  keys(config,['manifestFile','agentStateFile','challengeFile','hostStateDir','companionFile','outputFile']);
  protectedDirectory(config.hostStateDir);protectedDirectory(dirname(config.outputFile));
  const m=manifestAt(config.manifestFile),c=challengeAt(config.challengeFile,m,now);
  const agent=fenceAt(config.agentStateFile,m,['target_staged']);
  if(!loadUsers(config.hostStateDir)?.includes(m.sourceUserId))throw Error('目标Host没有原用户授权');
  const file=join(config.hostStateDir,'personal-handoff.json'),receipt=receiptFor(m,agent.targetReceipt);
  return withPairingsLock(config.hostStateDir,()=>{
    const prior=readPairings(config.hostStateDir);
    let state,reused=false;
    if(existsSync(file)) {
      state=readPrivateHandoffJSON(file);
      const offer=readPrivateHandoffJSON(config.outputFile);
      if(state.claims?.migrationId!==m.migrationId||state.claims?.nonce!==c.nonce||state.claims?.manifestSHA256!==receipt.manifestSHA256||
        state.agentStateFile!==config.agentStateFile||handoffDigest(offer.connection?.token??'')!==state.claims?.targetCredentialSHA256)
        throw Error('目标Host已有另一交接或凭据副本缺失');
      reused=true;
    }else{
      if(prior.length)throw Error('专用目标Host绑定表不是空的');
      let token=randomBytes(32).toString('hex');
      if(existsSync(config.outputFile)) {
        const offer=readPrivateHandoffJSON(config.outputFile);
        if(offer.connection?.baseURL!==m.targetOrigin||!hash(offer.connection.token)||
          canonicalHandoffJSON(offer.cloudReceipt)!==canonicalHandoffJSON(receipt))throw Error('已有另一凭据交付副本');
        token=offer.connection.token;
      }
      const claims=claimsFor(m,c,token,receipt,now);
      state={version:1,claims,agentStateFile:config.agentStateFile,importReceiptSHA256:claims.importReceiptSHA256,
        importReceiptUTF8:canonicalHandoffJSON(receipt)};
      // Save the only plaintext delivery copy before publishing its hash. A crash is recoverable
      // from this same private file; no plaintext token is returned from status or logs.
      writePrivateHandoffJSON(config.outputFile,{format:'along-workspace-handoff-offer/v1',
        connection:{baseURL:m.targetOrigin,token,runtime:'dsh-superagent'},cloudReceipt:receipt});
      writePrivateHandoffJSON(file,state);
    }
    if(prior.length&&!(prior.length===1&&prior[0].hash===state.claims.targetCredentialSHA256&&
      prior[0].user_id===m.sourceUserId&&prior[0].device_id===m.sourceDeviceId))throw Error('目标绑定在交接期间已改变');
    installHostCompanion({hostStateDir:config.hostStateDir,companionFile:config.companionFile,manifest:m,targetReceipt:agent.targetReceipt});
    if(!prior.length)savePairings(config.hostStateDir,[{hash:state.claims.targetCredentialSHA256,user_id:m.sourceUserId,
      device_id:m.sourceDeviceId,expiresAt:now*1000+BINDING_TTL_MS}]);
    return {staged:true,reused};
  });
}
export function signSourceHandoff(config,now=Math.floor(Date.now()/1000)) {
  keys(config,['manifestFile','agentStateFile','challengeFile','hostStateDir','targetOfferFile','outputFile']);
  protectedDirectory(config.hostStateDir);protectedDirectory(dirname(config.outputFile));
  const m=manifestAt(config.manifestFile),c=challengeAt(config.challengeFile,m,now);
  fenceAt(config.agentStateFile,m,['source_retired']);
  const pair=readPairings(config.hostStateDir).find(p=>p.user_id===m.sourceUserId&&p.device_id===m.sourceDeviceId&&p.hash===c.sourceCredentialSHA256);
  if(!pair)throw Error('原Host配对承诺不匹配');
  const offer=readPrivateHandoffJSON(config.targetOfferFile);keys(offer,['format','connection','cloudReceipt']);
  keys(offer.connection,['baseURL','token','runtime']);
  if(offer.format!=='along-workspace-handoff-offer/v1'||offer.connection.baseURL!==m.targetOrigin||
    !hash(offer.connection.token)||offer.connection.runtime!=='dsh-superagent'||
    canonicalHandoffJSON(offer.cloudReceipt)!==canonicalHandoffJSON(receiptFor(m,offer.cloudReceipt?.targetReceipt)))throw Error('云凭据或导入回执不匹配');
  const key=join(config.hostStateDir,'key.pem'),cert=join(config.hostStateDir,'cert.pem'),keyStat=lstatSync(key),certStat=lstatSync(cert);
  if(!keyStat.isFile()||keyStat.isSymbolicLink()||(keyStat.mode&0o077)||keyStat.uid!==process.getuid()||
    !certStat.isFile()||certStat.isSymbolicLink())throw Error('原Host签名材料权限无效');
  const claims=claimsFor(m,c,offer.connection.token,offer.cloudReceipt,now);
  const proof=signWorkspaceHandoff(claims,{certificatePEM:readFileSync(cert),privateKeyPEM:readFileSync(key),now});
  if(handoffDigest(Buffer.from(proof.certificateDER,'base64')).toUpperCase()!==c.sourceFingerprint.toUpperCase())throw Error('原Host证书不是手机已信任的pin');
  writePrivateHandoffJSON(config.outputFile,{format:'along-native-workspace-handoff/v1',connection:offer.connection,proof,
    manifestUTF8:canonicalHandoffJSON(m)});
  return {signed:true};
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const [mode,configFile,...extra]=process.argv.slice(2);
    if(extra.length||!['export-companion','stage-target','sign-source'].includes(mode)||!configFile)throw Error('用法: workspace-handoff-admin.mjs export-companion|stage-target|sign-source private-config.json');
    const config=readPrivateHandoffJSON(configFile);
    if(mode==='export-companion')keys(config,['hostStateDir','sourceUserId','sourceDeviceId','sourceCredentialSHA256','goalIds','outputFile']);
    console.log(JSON.stringify(mode==='export-companion'?exportHostCompanion(config):mode==='stage-target'?await stageTargetHandoff(config):signSourceHandoff(config)));
  }catch{console.error('个人工作区交接管理未完成；请检查受保护的输入、围栏与状态');process.exitCode=1;}
}
