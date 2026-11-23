import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {request as tlsRequest} from 'node:https';
import net from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeTestCa} from './cloud-ca-fixture.mjs';

// 云端形态的真实进程行为（docs/iphone-ca-profile-design.md §3.1/§7「服务端 TLS」、§8 T05/T20）：
// - 多用户形态（users.json 在场）读 tls/current 的预签发叶证书，不再现场自签；
// - 缺证/不合规则在监听前退出，不自签兜底；
// - 本地单用户形态（Mac）保持既有自签行为不变。

const HOST_FILE=fileURLToPath(new URL('../host/agent-host.mjs',import.meta.url));

function freePort() {
  return new Promise(resolve=>{
    const server=net.createServer();
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});
  });
}


function stageRelease(stateDir,ca,serial) {
  const version=join(stateDir,'tls','releases',serial);
  mkdirSync(version,{recursive:true,mode:0o700});
  writeFileSync(join(version,'fullchain.pem'),readFileSync(join(ca,'leaf.crt')));
  writeFileSync(join(version,'key.pem'),readFileSync(join(ca,'leaf.key')));
  writeFileSync(join(version,'root.crt'),readFileSync(join(ca,'ca.crt')));
  chmodSync(join(version,'key.pem'),0o600);
  chmodSync(join(version,'fullchain.pem'),0o644);
  chmodSync(join(version,'root.crt'),0o644);
  chmodSync(version,0o700);
  const current=join(stateDir,'tls','current');
  if(existsSync(current)) rmSync(current,{force:true});
  symlinkSync(version,current);
  return version;
}

function writeUsers(stateDir) {
  writeFileSync(join(stateDir,'users.json'),JSON.stringify([{userId:'u_aaaaaaaa'},{userId:'u_bbbbbbbb'}]),{mode:0o600});
}

function healthCall(port) {
  return new Promise((resolve,reject)=>{
    const req=tlsRequest({host:'127.0.0.1',port,path:'/health',method:'GET',rejectUnauthorized:false,agent:false},
      res=>{
        let text='';res.on('data',chunk=>text+=chunk);
        res.on('end',()=>resolve({status:res.statusCode,text}));
      });
    req.setTimeout(10_000,()=>req.destroy(new Error('healthCall 超时')));
    req.on('error',reject);
    req.end();
  });
}

// 启动 Host 并等到它监听（或退出）。
async function startHost({dir,tlsEnv={},cloud=true}) {
  const port=await freePort();
  // 云端形态的判据是「配置了云端 Runner」（docs/iphone-ca-profile-design.md §3.1），
  // 所以这里给出 runner URL 与 runner-token；runner 本身不可达不影响 Host 启动。
  const tokenFile=join(dir,'runner-token');
  writeFileSync(tokenFile,'cd'.repeat(32),{mode:0o600});
  const env={...process.env,ALONG_AGENT_STATE_DIR:dir,ALONG_AGENT_HOST:'127.0.0.1',ALONG_AGENT_PORT:String(port),
    ...(cloud?{ALONG_DSH_RUNNER_URL:'http://127.0.0.1:1',ALONG_RUNNER_TOKEN_FILE:tokenFile}:{})};
  delete env.ALONG_TLS_DAYS;delete env.ALONG_TLS_CN;
  Object.assign(env,tlsEnv);
  const child=spawn(process.execPath,[HOST_FILE],{env,stdio:['ignore','pipe','pipe']});
  const output=[];
  child.stdout.on('data',data=>output.push(String(data)));
  child.stderr.on('data',data=>output.push(String(data)));
  let exited=false;
  child.once('exit',()=>{exited=true;});
  const deadline=Date.now()+20_000;
  while (Date.now()<deadline&&!exited) {
    try { const health=await healthCall(port); if (health.status===200) break; } catch { /* 还没起来 */ }
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  return {
    port,child,
    exited:()=>exited,
    text:()=>output.join(''),
    stop:()=>new Promise(resolve=>{
      if (exited||child.exitCode!==null) return resolve();
      child.once('exit',()=>resolve());
      child.kill('SIGINT');
      setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},3_000).unref?.();
    }),
  };
}

test('云端形态：读预签发 CA 叶证书并监听，不现场自签',async t=>{
  const base=mkdtempSync(join(tmpdir(),'along-cloud-ca-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const dir=join(base,'data');
  mkdirSync(dir,{recursive:true,mode:0o700});
  writeUsers(dir);
  const ca=makeTestCa(join(base,'ca'),'along.test.local');
  stageRelease(dir,ca,'v1');
  const host=await startHost({dir,tlsEnv:{ALONG_TLS_CN:'along.test.local'}});
  t.after(async()=>{await host.stop();});
  assert.equal(host.exited(),false,`Host 应该起来：${host.text().slice(0,400)}`);
  assert.match(host.text(),/Along 服务: https:\/\/127\.0\.0\.1/);
  assert.match(host.text(),/云端 CA 叶证书版本: v1/);
  // 云端不应再生成自签证书。
  assert.equal(existsSync(join(dir,'cert.pem')),false,'云端不应现场自签');
  // 出示的证书就是预签发的那张：SAN 与根都对得上。
  const subject=execFileSync('openssl',['x509','-in',join(ca,'leaf.crt'),'-noout','-subject'],{encoding:'utf8'});
  assert.match(subject,/along\.test\.local/);
});

test('云端形态：缺证书就拒启，不自签兜底',async t=>{
  const base=mkdtempSync(join(tmpdir(),'along-cloud-ca-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const dir=join(base,'data');
  mkdirSync(dir,{recursive:true,mode:0o700});
  writeUsers(dir);
  const host=await startHost({dir,tlsEnv:{ALONG_TLS_CN:'along.test.local'}});
  t.after(async()=>{await host.stop();});
  assert.equal(host.exited(),true,'缺证必须在监听前退出');
  assert.match(host.text(),/云端 TLS/);
  assert.equal(existsSync(join(dir,'cert.pem')),false,'不许自签兜底');
});

test('云端形态：SAN 不覆盖期望域名就拒启',async t=>{
  const base=mkdtempSync(join(tmpdir(),'along-cloud-ca-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const dir=join(base,'data');
  mkdirSync(dir,{recursive:true,mode:0o700});
  writeUsers(dir);
  const ca=makeTestCa(join(base,'ca'),'along.test.local');
  stageRelease(dir,ca,'v1');
  const host=await startHost({dir,tlsEnv:{ALONG_TLS_CN:'other.test.local'}});
  t.after(async()=>{await host.stop();});
  assert.equal(host.exited(),true,'SAN 不匹配必须拒启');
  assert.match(host.text(),/SAN/);
});

test('本地单用户形态：仍是既有自签行为，不受云端策略影响',async t=>{
  const base=mkdtempSync(join(tmpdir(),'along-local-tls-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const dir=join(base,'data');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const host=await startHost({dir,cloud:false});
  t.after(async()=>{await host.stop();});
  assert.equal(host.exited(),false,`Host 应该起来：${host.text().slice(0,400)}`);
  assert.match(host.text(),/证书指纹 SHA-256/);
  assert.equal(existsSync(join(dir,'cert.pem')),true,'本地形态仍自签');
});

