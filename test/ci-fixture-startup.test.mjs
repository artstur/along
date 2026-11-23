import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {X509Certificate} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSecureContext} from 'node:tls';
import {provideCloudCa} from './cloud-ca-fixture.mjs';

// Run the real contract setup in an owned process group. Only its synthetic Host
// is replaced; leaked runner listeners must not keep a failed test alive.
for (const [label,file,pattern] of [
  ['contract','./agent-runner-contract.test.mjs','设置 ALONG_DSH_RUNNER_URL 后 Kimi'],
  ['agreement','./host-runner-agreement.test.mjs','ALONG_DSH_RUNNER_URL 分流'],
  ['blocked agreement','./host-runner-agreement.test.mjs','runner 返回校验失败的目标输出'],
]) test(`${label} fixture exits after Host startup fails, without leaking the stub runner`,
  {skip:process.platform==='win32'},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-ci-startup-'));
  const hostFile=fileURLToPath(new URL('../host/agent-host.mjs',import.meta.url));
  const contractFile=fileURLToPath(new URL(file,import.meta.url));
  const preload=join(dir,'fail-host.mjs');
  writeFileSync(preload,`
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const original=cp.spawn;
    cp.spawn=(command,args,options)=>args?.[0]===${JSON.stringify(hostFile)}
      ?original(process.execPath,['-e',"process.exit(71)"],options)
      :original(command,args,options);
    syncBuiltinESMExports();
  `);
  let child;
  const killOwnedGroup=()=>{if(child?.pid){try{process.kill(-child.pid,'SIGKILL');}catch{}}};
  try {
    const env={...process.env};
    delete env.NODE_TEST_CONTEXT; // A nested runner must create its own test workers.
    child=spawn(process.execPath,['--import',preload,'--test',
      `--test-name-pattern=${pattern}`,contractFile],
      {env,detached:true,stdio:['ignore','pipe','pipe']});
    let output='';
    child.stdout.on('data',chunk=>output+=chunk);
    child.stderr.on('data',chunk=>output+=chunk);
    const result=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{killOwnedGroup();resolve({timedOut:true});},20_000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,timedOut:false});});
    });
    assert.equal(result.timedOut,false,`启动失败后测试进程仍未退出，可能泄漏stub runner/Host：\n${output}`);
    assert.notEqual(result.code,0,'强制Host启动失败必须报告测试失败');
    assert.match(output,/host.*(?:退出|exited).*71/i,'启动失败应包含子进程退出状态');
  } finally {killOwnedGroup();rmSync(dir,{recursive:true,force:true});}
});

test('separate cloud CA fixtures do not overwrite each other and retain matching TLS material',()=>{
  const root=mkdtempSync(join(tmpdir(),'along-ci-ca-'));
  try {
    const first=provideCloudCa(join(root,'state-a'),{host:'first.along.test'});
    const original=readFileSync(join(first.ca,'ca.crt'));
    const second=provideCloudCa(join(root,'state-b'),{host:'second.along.test'});
    assert.notEqual(first.ca,second.ca,'different test states must not share CA/leaf files');
    assert.deepEqual(readFileSync(join(first.ca,'ca.crt')),original,'another fixture must not replace the first CA');
    for(const state of ['state-a','state-b']){
      const current=join(root,state,'tls','current');
      assert.doesNotThrow(()=>createSecureContext({
        cert:readFileSync(join(current,'fullchain.pem')),key:readFileSync(join(current,'key.pem')),
      }));
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

// Real independent Node processes exercise the same parallelism as check, while
// all certificate files remain under this test's own temporary parent.
test('parallel cloud CA generation keeps each state certificate/key/root consistent',async()=>{
  const root=mkdtempSync(join(tmpdir(),'along-ci-ca-parallel-'));
  const fixtureUrl=new URL('./cloud-ca-fixture.mjs',import.meta.url).href;
  const exec=promisify(execFile);
  try {
    await Promise.all([0,1,2,3].map(async index=>{
      const state=join(root,`state-${index}`);
      const source=`import {provideCloudCa} from ${JSON.stringify(fixtureUrl)};provideCloudCa(process.argv[1]);`;
      await exec(process.execPath,['--input-type=module','-e',source,state],{timeout:20_000});
      const current=join(state,'tls','current');
      const cert=readFileSync(join(current,'fullchain.pem'));
      const key=readFileSync(join(current,'key.pem'));
      const ca=readFileSync(join(current,'root.crt'));
      assert.doesNotThrow(()=>createSecureContext({cert,key}));
      const rootCert=new X509Certificate(ca);
      assert.equal(rootCert.ca,true,'签名可验证也必须证明根有CA用途');
      assert.equal(new X509Certificate(cert).verify(rootCert.publicKey),true);
    }));
  } finally {rmSync(root,{recursive:true,force:true});}
});

// A real ambient v3_ca config used with -addext duplicates the same OIDs in
// both LibreSSL and OpenSSL 1.1.1; Node then correctly rejects the root as a CA.
test('cloud CA constraints are explicit once even when ambient OpenSSL config defines v3_ca',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-ci-ca-defaults-'));
  const conf=join(dir,'ambient.cnf');
  writeFileSync(conf,'[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\n[dn]\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
  const fixtureUrl=new URL('./cloud-ca-fixture.mjs',import.meta.url).href;
  const tlsUrl=new URL('../host/tls-material.mjs',import.meta.url).href;
  const source=`
    import {provideCloudCa} from ${JSON.stringify(fixtureUrl)};
    import {loadCloudTlsMaterial} from ${JSON.stringify(tlsUrl)};
    import {X509Certificate} from 'node:crypto';
    import {readFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {execFileSync} from 'node:child_process';
    const {ca}=provideCloudCa(process.argv[1]);
    const cert=new X509Certificate(readFileSync(join(ca,'ca.crt')));
    const text=execFileSync('openssl',['x509','-in',join(ca,'ca.crt'),'-noout','-text'],{encoding:'utf8'});
    let error=null;try{loadCloudTlsMaterial({stateDir:process.argv[1],host:'along.test.local'});}catch(e){error=e.message;}
    console.log(JSON.stringify({ca:cert.ca,basicConstraints:(text.match(/X509v3 Basic Constraints/g)||[]).length,
      keyUsage:(text.match(/X509v3 Key Usage/g)||[]).length,error}));
  `;
  try {
    const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',source,join(dir,'state')],
      {env:{...process.env,OPENSSL_CONF:conf},timeout:20_000});
    assert.deepEqual(JSON.parse(stdout),{ca:true,basicConstraints:1,keyUsage:1,error:null});
  } finally {rmSync(dir,{recursive:true,force:true});}
});
