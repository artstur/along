import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {request} from 'node:https';
import net from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {fixture} from './helpers/workspace-handoff-fixture.mjs';
import {runtimeHandoffMatches,writePrivateHandoffJSON,readPrivateHandoffJSON,handoffDigest,canonicalHandoffJSON} from '../host/workspace-handoff.mjs';
import {stageTargetHandoff,signSourceHandoff} from '../host/workspace-handoff-admin.mjs';
import {savePairings} from '../host/pairing.mjs';

const privateJSON=(file,v)=>writeFileSync(file,JSON.stringify(v),{mode:0o600});
function targetFixture(dir) {
  const f=fixture(dir),{c,manifest,importReceiptUTF8}=f;
  const targetReceipt=JSON.parse(importReceiptUTF8).targetReceipt;
  const agentFile=join(dir,'agent-fence.json');privateJSON(agentFile,{version:1,phase:'target_active',manifest,targetReceipt});
  privateJSON(join(dir,'personal-handoff.json'),{version:1,claims:c,agentStateFile:agentFile,importReceiptSHA256:c.importReceiptSHA256,importReceiptUTF8});
  privateJSON(join(dir,'personal-handoff-companion.json'),{format:'along-host-companion-receipt/v1',migrationId:c.migrationId,sourceUserId:c.userId,sourceDeviceId:c.deviceId,sourceCredentialSHA256:c.sourceCredentialSHA256,hostCompanionSHA256:manifest.hostCompanionSHA256});
  const witness={format:'along-personal-handoff/source-status/v1',phase:'target_active',migrationId:c.migrationId,userId:c.userId,deviceId:c.deviceId,
    manifestSHA256:c.manifestSHA256,snapshotSHA256:c.snapshotSHA256,syncPrefixSHA256:c.syncPrefixSHA256,syncHighWaterMark:117,
    activationPermitSHA256:c.activationPermitSHA256,hostCompanionSHA256:manifest.hostCompanionSHA256,sourceHolds:[],targetReceipt};
  return {...f,agentFile,witness};
}
test('actual Source witness must match the complete imported workspace, not just ready and matching IDs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-witness-'));
  try{
    const {c,witness,importReceiptUTF8}=targetFixture(dir);
    const status={...c,phase:'target_active',syncHighWaterMark:117,hostCompanionSHA256:witness.hostCompanionSHA256,importReceiptUTF8};
    assert.equal(runtimeHandoffMatches(status,witness),true);
    for(const change of [{ready:true,userId:c.userId,deviceId:c.deviceId},{...witness,manifestSHA256:'0'.repeat(64)},
      {...witness,phase:'target_staged'},{...witness,targetReceipt:{...witness.targetReceipt,snapshotSHA256:'0'.repeat(64)}},
      {...witness,sourceHolds:[{}]},{...witness,syncHighWaterMark:118}])assert.equal(runtimeHandoffMatches(status,change),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
function phone(port,path,token,body={}){return new Promise((resolve,reject)=>{
  const text=JSON.stringify(body),req=request({hostname:'127.0.0.1',port,path,method:'POST',rejectUnauthorized:false,agent:false,
    headers:{authorization:'Bearer '+token,'content-type':'application/json','content-length':Buffer.byteLength(text)}},res=>{
      let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(data)}));});
  req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('test timeout')));req.end(text);
});}
test('real Host rejects old/empty Source even when the ordinary probe is ready, then accepts the actual imported Source',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-handoff-host-'));let child,server;
  try {
    const f=targetFixture(dir),token='a'.repeat(64),{c}=f;
    // Synthetic target credential is bound to the target phone. This fixture does not perform a pairing.
    c.targetCredentialSHA256=handoffDigest(token);
    privateJSON(join(dir,'personal-handoff.json'),{version:1,claims:c,agentStateFile:f.agentFile,importReceiptSHA256:c.importReceiptSHA256,importReceiptUTF8:f.importReceiptUTF8});
    savePairings(dir,[{hash:c.targetCredentialSHA256,user_id:c.userId,device_id:c.deviceId,expiresAt:Date.now()+86400000}]);
    privateJSON(join(dir,'users.json'),[{userId:c.userId,label:'Synthetic'}]);
    writeFileSync(join(dir,'bridge-token'),'b'.repeat(64),{mode:0o600});
    let mode='empty';const calls=[];
    server=createServer(async(req,res)=>{
      let raw='';for await(const part of req)raw+=part;
      const path=new URL(req.url,'http://x').pathname;calls.push({path,headers:req.headers});
      let data={};let status=200;
      if(path==='/along-source/api/workspace-handoff/status'){
        if(mode==='empty'){status=404;data={error:'no_active_import'};}
        else data=mode==='wrong'?{...f.witness,manifestSHA256:'0'.repeat(64)}:f.witness;
      }else if(path.endsWith('/along-status-probe'))data={service:'along-source',ready:true};
      else if(path.endsWith('/source-reads'))data={requests:[]};
      else if(path.endsWith('/goals')||path.endsWith('/sync'))data={items:[]};
      res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=await freePort();
    child=spawn(process.execPath,[fileURLToPath(new URL('../host/agent-host.mjs',import.meta.url))],{env:{...process.env,
      ALONG_AGENT_STATE_DIR:dir,ALONG_AGENT_HOST:'127.0.0.1',ALONG_AGENT_PORT:String(port),ALONG_EVENT_INGEST:'on',
      ALONG_SUPERAGENT_URL:`http://127.0.0.1:${server.address().port}`,ALONG_BRIDGE_TOKEN_FILE:join(dir,'bridge-token')},stdio:'pipe'});
    let error='';child.stderr.on('data',x=>error+=x);child.stdout.on('data',()=>{});
    let result;for(let n=0;n<100;n++){try{result=await phone(port,'/workspace-handoff/status',token);break;}catch{await new Promise(r=>setTimeout(r,80));}}
    assert.ok(result,'Host should start: '+error.slice(0,200));assert.equal(result.status,503);
    mode='wrong';assert.equal((await phone(port,'/workspace-handoff/status',token)).status,409);
    mode='active';result=await phone(port,'/workspace-handoff/status',token);assert.equal(result.status,200);assert.equal(result.json.handoffReady,true);
    assert.ok(calls.filter(x=>x.path.endsWith('workspace-handoff/status')).every(x=>x.headers['x-along-user']===c.userId&&x.headers['x-along-device']===c.deviceId));
    assert.equal((await phone(port,'/workspace-handoff/status','c'.repeat(64))).status,401);
    assert.equal((await phone(port,'/workspace-handoff/status',token,{userId:c.userId})).status,400);
    privateJSON(f.agentFile,{version:1,phase:'target_staged',manifest:f.manifest,targetReceipt:f.witness.targetReceipt});
    const before=calls.filter(x=>x.path.endsWith('workspace-handoff/status')).length;
    result=await phone(port,'/workspace-handoff/status',token);assert.equal(result.status,200);assert.equal(result.json.handoffReady,false);
    assert.equal(calls.filter(x=>x.path.endsWith('workspace-handoff/status')).length,before,'staged status must not probe/start Runtime');
  }finally{
    if(child&&child.exitCode===null){await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGINT');setTimeout(()=>child.kill('SIGKILL'),3000).unref();});}
    if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});
  }
});

test('private handoff files refuse public permissions and non-plain paths',()=>{
 const dir=mkdtempSync(join(tmpdir(),'along-private-handoff-'));
 try{const p=join(dir,'file.json');writePrivateHandoffJSON(p,{safe:true});assert.equal(readPrivateHandoffJSON(p).safe,true);
 chmodSync(p,0o644);assert.throws(()=>readPrivateHandoffJSON(p));assert.throws(()=>readPrivateHandoffJSON(dir));}
 finally{rmSync(dir,{recursive:true,force:true});}
});

test('local admin retains original business device, publishes once and signs only after source retirement',async()=>{
 const root=mkdtempSync(join(tmpdir(),'along-handoff-admin-'));
 try {
  const f=fixture(root),{c}=f,source=join(root,'source'),target=join(root,'target');mkdirSync(source,{mode:0o700});mkdirSync(target,{mode:0o700});
  const companion={format:'along-host-personal-handoff/v1',sourceUserId:c.userId,sourceDeviceId:c.deviceId,sourceCredentialSHA256:c.sourceCredentialSHA256,
    goalIds:f.manifest.goalIds,sourceJournal:{version:1,sources:{},deliveries:{}},notificationLedger:null,daily:[]};
  const manifest={...f.manifest,hostCompanionSHA256:handoffDigest(canonicalHandoffJSON(companion))};
  const manifestFile=join(root,'manifest.json'),companionFile=join(root,'companion.json'),challengeFile=join(root,'challenge.json'),targetFence=join(root,'target-fence.json'),sourceFence=join(root,'source-fence.json');
  const challenge={purpose:c.purpose,sourceOrigin:c.sourceOrigin,targetOrigin:c.targetOrigin,sourceFingerprint:handoffDigest(Buffer.from(f.proof.certificateDER,'base64')).toUpperCase(),
    sourceCredentialSHA256:c.sourceCredentialSHA256,userId:c.userId,nonce:c.nonce,createdAt:f.now,expiresAt:f.now+1000};
  privateJSON(manifestFile,manifest);privateJSON(companionFile,companion);privateJSON(challengeFile,challenge);
  privateJSON(targetFence,{version:1,phase:'target_staged',manifest,targetReceipt:JSON.parse(f.importReceiptUTF8).targetReceipt});
  privateJSON(sourceFence,{version:1,phase:'source_frozen',manifest});privateJSON(join(target,'users.json'),[{userId:c.userId,label:'Synthetic'}]);
  savePairings(source,[{hash:c.sourceCredentialSHA256,user_id:c.userId,device_id:c.deviceId,expiresAt:Date.now()+86400000}]);
  writeFileSync(join(source,'key.pem'),f.key,{mode:0o600});writeFileSync(join(source,'cert.pem'),f.cert,{mode:0o600});
  const outputFile=join(root,'cloud-offer.json'),stage={manifestFile,companionFile,agentStateFile:targetFence,challengeFile,hostStateDir:target,outputFile};
  assert.deepEqual(await stageTargetHandoff(stage,f.now),{staged:true,reused:false});const first=readFileSync(outputFile,'utf8');
  assert.deepEqual(await stageTargetHandoff(stage,f.now),{staged:true,reused:true});assert.equal(readFileSync(outputFile,'utf8'),first,'retry keeps same new token');
  const {readPairings}=await import('../host/pairing.mjs');assert.equal(readPairings(target)[0].device_id,c.deviceId);assert.equal(readPairings(target)[0].user_id,c.userId);
  const signedFile=join(root,'native-offer.json'),sign={manifestFile,agentStateFile:sourceFence,challengeFile,hostStateDir:source,targetOfferFile:outputFile,outputFile:signedFile};
  assert.throws(()=>signSourceHandoff(sign,f.now));privateJSON(sourceFence,{version:1,phase:'source_retired',manifest});
  assert.deepEqual(signSourceHandoff(sign,f.now),{signed:true});const native=JSON.parse(readFileSync(signedFile,'utf8'));
  assert.equal(native.format,'along-native-workspace-handoff/v1');assert.equal(native.manifestUTF8,canonicalHandoffJSON(manifest));assert.equal(native.proof.claims,undefined);
  assert.match(native.proof.payload,/sourcePhase=source_retired\n/);assert.notEqual(native.connection.token,c.sourceCredentialSHA256);
  privateJSON(challengeFile,{...challenge,userId:'u_aaaaaaaa'});await assert.rejects(()=>stageTargetHandoff(stage,f.now));
 }finally{rmSync(root,{recursive:true,force:true});}
});
