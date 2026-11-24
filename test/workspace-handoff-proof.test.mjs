import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,sign,constants} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {HANDOFF_PURPOSE,handoffDigest,canonicalHandoffJSON,canonicalHandoffOrigin,validateHandoffClaims,signWorkspaceHandoff,validateHandoffTargetReceipt} from '../host/workspace-handoff.mjs';

function fixture(dir) {
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

test('handoff claims have one purpose, source retirement, canonical origin, complete manifest and bounded lifetime',()=>{
  const dir=mkdtempSync(join(tmpdir(),'handoff-claims-'));
  try {
    const {c,now}=fixture(dir);
    assert.equal(validateHandoffClaims(c,now),c);
    for(const change of [{purpose:'generic-signing'},{sourcePhase:'source_frozen'},{expiresAt:String(now+901)},
      {targetOrigin:'https://cloud.example.com/other'},{targetOrigin:c.sourceOrigin},{userId:'other-user'},
      {syncHighWaterMark:'01'},{syncHighWaterMark:'9007199254740992'},{nonce:'\n'+'8'.repeat(63)},
      {manifestSHA256:'unknown'},{activationPermitSHA256:'unknown'},{extra:'not-allowed'}])
      assert.throws(()=>validateHandoffClaims({...c,...change},now));
    assert.equal(canonicalHandoffOrigin('https://cloud.example.com'),'https://cloud.example.com');
    assert.throws(()=>canonicalHandoffOrigin('https://cloud.example.com:443'));
    assert.equal(canonicalHandoffJSON({z:'广深/路线',a:{b:2,a:1}}),'{"a":{"a":1,"b":2},"z":"广深/路线"}');
    assert.throws(()=>canonicalHandoffJSON({a:NaN}));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

const hasSwift=process.platform==='darwin'&&spawnSync('swiftc',['--version']).status===0;
test('real Swift verifies original UTF8 signature before strict parsing and refuses tampering or wrong pins',{skip:!hasSwift},()=>{
  const dir=mkdtempSync(join(tmpdir(),'handoff-native-proof-'));
  try {
    const {key,now,c,proof,manifest,importReceiptUTF8}=fixture(dir);
    const pin=createHash('sha256').update(Buffer.from(proof.certificateDER,'base64')).digest('hex').toUpperCase();
    const status={purpose:HANDOFF_PURPOSE,migrationId:c.migrationId,userId:c.userId,deviceId:c.deviceId,phase:'target_active',
      manifestSHA256:c.manifestSHA256,importReceiptSHA256:c.importReceiptSHA256,snapshotSHA256:c.snapshotSHA256,
      syncPrefixSHA256:c.syncPrefixSHA256,syncHighWaterMark:117,activationPermitSHA256:c.activationPermitSHA256,
      importReceiptUTF8,eventProtocol:1,handoffReady:true,hostCompanionSHA256:manifest.hostCompanionSHA256};
    const variants=[{name:'valid',proof,pin,valid:true},
      {name:'wrong-pin',proof,pin:'A'.repeat(64),valid:false},
      {name:'tamper',proof:{...proof,payload:proof.payload.replace('source_retired','source_frozen')},pin,valid:false},
      {name:'wrong-signature',proof:{...proof,signature:Buffer.alloc(256).toString('base64')},pin,valid:false}];
    for(const [name,payload] of [
      ['signed-wrong-purpose',proof.payload.replace(HANDOFF_PURPOSE,'unrestricted-signing')],
      ['signed-reordered-fields',proof.payload.replace('purpose='+HANDOFF_PURPOSE+'\nmigrationId='+c.migrationId,'migrationId='+c.migrationId+'\npurpose='+HANDOFF_PURPOSE)],
      ['signed-duplicate-field',proof.payload+'nonce='+c.nonce+'\n'],
      ['signed-missing-final-newline',proof.payload.slice(0,-1)],
      ['signed-non-ascii',proof.payload.replace(c.migrationId,'handoff-中文')],
    ])variants.push({name,proof:{...proof,payload,signature:sign('sha256',Buffer.from(payload),{key,padding:constants.RSA_PKCS1_PADDING}).toString('base64')},pin,valid:false});
    // Versioned fixtures copied byte-for-byte from Along Agent PR35 fixed 640b637.
    const plain=JSON.parse(readFileSync(new URL('./fixtures/personal-handoff-manifest.json',import.meta.url),'utf8'));
    const historical=JSON.parse(readFileSync(new URL('./fixtures/personal-handoff-history-receipt.json',import.meta.url),'utf8'));
    const contracts=[{manifest:plain,targetReceipt:{snapshotSHA256:plain.snapshotSHA256,syncHighWaterMark:plain.syncHighWaterMark,sourceHolds:[]}},historical].map(pair=>{
      const m=pair.manifest;validateHandoffTargetReceipt(m,pair.targetReceipt);
      const cc={...c,migrationId:m.migrationId,userId:m.sourceUserId,deviceId:m.sourceDeviceId,targetOrigin:m.targetOrigin,
        manifestSHA256:handoffDigest(canonicalHandoffJSON(m)),snapshotSHA256:m.snapshotSHA256,syncPrefixSHA256:m.syncPrefixSHA256,
        syncHighWaterMark:String(m.syncHighWaterMark),activationPermitSHA256:m.activationPermitSHA256};
      const rr={format:'along-host-import-receipt/v1',phase:'target_staged',manifestSHA256:cc.manifestSHA256,migrationId:m.migrationId,sourceUserId:m.sourceUserId,
        sourceDeviceId:m.sourceDeviceId,targetOrigin:m.targetOrigin,snapshotSHA256:m.snapshotSHA256,syncPrefixSHA256:m.syncPrefixSHA256,
        syncHighWaterMark:m.syncHighWaterMark,activationPermitSHA256:m.activationPermitSHA256,targetReceipt:pair.targetReceipt};
      const raw=canonicalHandoffJSON(rr);cc.importReceiptSHA256=handoffDigest(raw);
      return {proof:signWorkspaceHandoff(cc,{certificatePEM:readFileSync(join(dir,'cert.pem')),privateKeyPEM:key,now}),manifestUTF8:canonicalHandoffJSON(m),
        status:{...status,migrationId:m.migrationId,userId:m.sourceUserId,deviceId:m.sourceDeviceId,manifestSHA256:cc.manifestSHA256,snapshotSHA256:m.snapshotSHA256,
          syncPrefixSHA256:m.syncPrefixSHA256,syncHighWaterMark:m.syncHighWaterMark,activationPermitSHA256:m.activationPermitSHA256,
          hostCompanionSHA256:m.hostCompanionSHA256,importReceiptSHA256:cc.importReceiptSHA256,importReceiptUTF8:raw}};
    });
    const file=join(dir,'input.json');writeFileSync(file,JSON.stringify({variants,now,status,manifestUTF8:canonicalHandoffJSON(manifest),contracts}));
    // JSON slash escaping is deliberately changed in transport. It must not affect the raw
    // decoded UTF8 payload bytes and must not require Foundation to serialize JSON again.
    writeFileSync(join(dir,'escaped.json'),readFileSync(file,'utf8').replaceAll('/', '\\/'));
    writeFileSync(join(dir,'Main.swift'),`import Foundation
import Security
@main struct Verify {
 static func main() throws {
  let input=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [String:Any]
  let now=Date(timeIntervalSince1970:input["now"] as! Double)
  for item in input["variants"] as! [[String:Any]] {
   var accepted=false
   do {let c=try WorkspaceHandoffProof.verifySignature(item["proof"] as! [String:Any],sourcePin:item["pin"] as! String,now:now);accepted=true
    if item["valid"] as! Bool {
     var status=input["status"] as! [String:Any]
     let manifest=try WorkspaceHandoffProof.manifest(input["manifestUTF8"] as! String,claims:c)
     precondition(WorkspaceHandoffProof.matchesStatus(status,claims:c,manifest:manifest))
     status["phase"]="target_staged";precondition(!WorkspaceHandoffProof.matchesStatus(status,claims:c,manifest:manifest))
     status=input["status"] as! [String:Any];status["manifestSHA256"]="bad";precondition(!WorkspaceHandoffProof.matchesStatus(status,claims:c,manifest:manifest))
    }
   }catch{}
   precondition(accepted == (item["valid"] as! Bool),item["name"] as! String)
  }
  for item in input["contracts"] as! [[String:Any]] {
   let c=try WorkspaceHandoffProof.verifySignature(item["proof"] as! [String:Any],sourcePin:input["variants"].flatMap{($0 as? [[String:Any]])?.first?["pin"] as? String}!,now:now)
   let manifest=try WorkspaceHandoffProof.manifest(item["manifestUTF8"] as! String,claims:c)
   precondition(WorkspaceHandoffProof.matchesStatus(item["status"] as! [String:Any],claims:c,manifest:manifest),"fixed P1 contract must match")
  }
  print("PASS original-bytes signature, strict fields, active receipt and negative proofs")
 }
}`);
    const binary=join(dir,'verify');
    execFileSync('swiftc',['-parse-as-library',fileURLToPath(new URL('../ios/AlongHealth/Sources/WorkspaceHandoff.swift',import.meta.url)),join(dir,'Main.swift'),'-o',binary],{timeout:90000});
    for(const input of [file,join(dir,'escaped.json')])assert.match(execFileSync(binary,[input],{encoding:'utf8'}),/PASS original-bytes/);
    assert.equal(handoffDigest(Buffer.from(proof.certificateDER,'base64')).toUpperCase(),pin);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
