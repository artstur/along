import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {HANDOFF_PURPOSE,handoffDigest,canonicalHandoffJSON,signWorkspaceHandoff} from '../../host/workspace-handoff.mjs';
export function fixture(dir) {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=along-handoff-synthetic'],{stdio:'pipe'});
  const key=readFileSync(join(dir,'key.pem')),cert=readFileSync(join(dir,'cert.pem')),now=Math.floor(Date.now()/1000);
  const c={purpose:HANDOFF_PURPOSE,migrationId:'handoff-synthetic-0001',sourceOrigin:'https://192.168.10.2:4176',targetOrigin:'https://cloud.example.com',
    userId:'u_12345678',deviceId:'d_12345678',sourceCredentialSHA256:'1'.repeat(64),targetCredentialSHA256:'2'.repeat(64),
    manifestSHA256:'3'.repeat(64),importReceiptSHA256:'4'.repeat(64),snapshotSHA256:'5'.repeat(64),syncPrefixSHA256:'6'.repeat(64),
    syncHighWaterMark:'117',activationPermitSHA256:'7'.repeat(64),sourcePhase:'source_retired',nonce:'8'.repeat(64),issuedAt:String(now),expiresAt:String(now+600)};
  const manifest={format:'along-personal-handoff/v1',migrationId:c.migrationId,sourceUserId:c.userId,sourceDeviceId:c.deviceId,
    schemaVersion:18,targetOrigin:c.targetOrigin,createdAt:new Date(now*1000).toISOString(),goalIds:['g_original'],
    snapshotSHA256:c.snapshotSHA256,syncPrefixSHA256:c.syncPrefixSHA256,syncHighWaterMark:117,
    activationPermitSHA256:c.activationPermitSHA256,hostCompanionSHA256:'a'.repeat(64),sourceHolds:[],tables:[{name:'goal',rowCount:1,sha256:'9'.repeat(64)}]};
  c.manifestSHA256=handoffDigest(canonicalHandoffJSON(manifest));
  const receipt={format:'along-host-import-receipt/v1',manifestSHA256:c.manifestSHA256,phase:'target_staged',
    migrationId:c.migrationId,sourceUserId:c.userId,sourceDeviceId:c.deviceId,targetOrigin:c.targetOrigin,
    snapshotSHA256:c.snapshotSHA256,syncPrefixSHA256:c.syncPrefixSHA256,syncHighWaterMark:117,activationPermitSHA256:c.activationPermitSHA256,
    targetReceipt:{snapshotSHA256:c.snapshotSHA256,syncHighWaterMark:117,sourceHolds:[]}};
  const importReceiptUTF8=canonicalHandoffJSON(receipt);c.importReceiptSHA256=handoffDigest(importReceiptUTF8);
  return {key,cert,now,c,manifest,importReceiptUTF8,proof:signWorkspaceHandoff(c,{certificatePEM:cert,privateKeyPEM:key,now})};
}
