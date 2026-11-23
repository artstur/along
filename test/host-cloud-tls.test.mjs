import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {request as tlsRequest} from 'node:https';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// 云端 TLS 与启动参数（docs/cloud-deploy-multi-user.md §4 M4，验收 #4）：真实进程 + 临时状态目录。
// - ALONG_TLS_CN=域名 + ALONG_TLS_DAYS=3650 启动 → cert.pem 的 CN 与 notAfter 符合、指纹打印；
// - 不设 env → 30 天 + CN=Along Local Agent，本地行为与现状一致；
// - 启动横幅打印绑定地址、证书指纹与到期时间（§3.7），到期时间从证书文件读取（不是本次 env）；
// - 证书与状态卷同生命周期：重启不重新生成，改 env 不换证书（§6.4 步骤 10 才换）。

const HOST_FILE=fileURLToPath(new URL('../host/agent-host.mjs',import.meta.url));

function freePort() {
  return new Promise(resolve=>{
    const server=net.createServer();
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port; server.close(()=>resolve(port));});
  });
}

// 手机视角的 HTTPS 调用（自签证书关校验，等同 App 的 pinning 信任）；本文件只探 /health。
function healthCall(port) {
  const attempt=()=>new Promise((resolve,reject)=>{
    const req=tlsRequest({host:'127.0.0.1',port,path:'/health',method:'GET',rejectUnauthorized:false,agent:false},
      res=>{
        let text=''; res.on('data',chunk=>text+=chunk);
        res.on('end',()=>resolve({status:res.statusCode,text}));
      });
    req.setTimeout(10_000,()=>{ req.destroy(new Error(`healthCall 超时（10s）@${port}`)); });
    req.on('error',reject);
    req.end();
  });
  return attempt().catch(error=>{
    if (['ECONNRESET','ECONNREFUSED','EPIPE'].includes(error.code)) return attempt();
    throw error;
  });
}

// 直接从证书文件独立读取（不经 host 进程）：CN、notAfter、SHA-256 指纹。
function certInfo(cert) {
  const subject=execFileSync('openssl',['x509','-in',cert,'-noout','-subject']).toString().trim();
  const notAfterText=execFileSync('openssl',['x509','-in',cert,'-noout','-enddate']).toString().trim().replace(/^notAfter=/,'');
  const der=execFileSync('openssl',['x509','-in',cert,'-outform','DER']);
  return {cn:/subject=CN=(.*)$/.exec(subject)?.[1]??null, notAfterText, notAfter:Date.parse(notAfterText),
    fingerprint:createHash('sha256').update(der).digest('hex').toUpperCase()};
}

async function spawnHost({dir,tlsEnv={}}) {
  const port=await freePort();
  const env={...process.env, ALONG_AGENT_STATE_DIR:dir, ALONG_AGENT_HOST:'127.0.0.1', ALONG_AGENT_PORT:String(port)};
  // 「不设 env」的场景要先删掉外部环境可能带进来的 TLS 变量，再按用例覆盖。
  delete env.ALONG_TLS_DAYS; delete env.ALONG_TLS_CN;
  Object.assign(env,tlsEnv);
  const child=spawn(process.execPath,[HOST_FILE],{env,stdio:['ignore','pipe','pipe']});
  const output=[];
  child.stdout.on('data',data=>output.push(String(data)));
  child.stderr.on('data',data=>output.push(String(data)));
  const deadline=Date.now()+30_000;
  let ready=false;
  while (Date.now()<deadline) {
    try { const health=await healthCall(port); if (health.status===200) {ready=true; break;} } catch { /* 还没起来（openssl 生成中） */ }
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  const text=output.join('');
  if (!ready && child.exitCode===null && !child.killed) child.kill('SIGKILL');
  assert.match(text,/Along 服务: https:\/\/127\.0\.0\.1/,`Host 进程要起来：${text.slice(0,400)}`);
  let stopped=false;
  return {port,text:()=>output.join(''),
    stop:()=>new Promise(resolve=>{
      if (stopped||child.exitCode!==null||child.signalCode!==null) {stopped=true; return resolve();}
      stopped=true;
      child.once('exit',()=>resolve());
      child.kill('SIGINT');
      setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},3_000).unref?.();
    })};
}

const DAY_MS=24*3600*1000;

test('ALONG_TLS_CN + ALONG_TLS_DAYS=3650：cert CN/notAfter 符合，横幅打印地址/指纹/到期',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-cloud-tls-'));
  const host=await spawnHost({dir,tlsEnv:{ALONG_TLS_CN:'along.example.com',ALONG_TLS_DAYS:'3650'}});
  t.after(async()=>{await host.stop();rmSync(dir,{recursive:true,force:true});});
  const info=certInfo(join(dir,'cert.pem'));
  assert.equal(info.cn,'along.example.com','cert.pem 的 CN 取自 ALONG_TLS_CN');
  // notAfter ≈ 启动时刻 + 3650 天：同一台机器生成，1 小时容差吸收生成耗时与时钟粒度。
  const expected=Date.now()+3650*DAY_MS;
  assert.ok(Math.abs(info.notAfter-expected)<3600*1000,`notAfter 应为 +3650 天，实际 ${info.notAfterText}`);
  assert.ok(host.text().includes(`Along 服务: https://127.0.0.1:${host.port}`),'横幅打印绑定地址与端口');
  assert.ok(host.text().includes(`证书指纹 SHA-256: ${info.fingerprint}`),'横幅指纹与证书文件独立计算一致');
  assert.ok(host.text().includes(`证书到期: ${info.notAfterText}`),'横幅打印证书到期时间');
});

test('不设 TLS env：默认 30 天 + CN=Along Local Agent，本地行为与现状一致',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-local-tls-'));
  const host=await spawnHost({dir});
  t.after(async()=>{await host.stop();rmSync(dir,{recursive:true,force:true});});
  const info=certInfo(join(dir,'cert.pem'));
  assert.equal(info.cn,'Along Local Agent','默认 CN 不变');
  const expected=Date.now()+30*DAY_MS;
  assert.ok(Math.abs(info.notAfter-expected)<3600*1000,`notAfter 应为 +30 天，实际 ${info.notAfterText}`);
  assert.ok(host.text().includes(`证书指纹 SHA-256: ${info.fingerprint}`));
  assert.ok(host.text().includes(`证书到期: ${info.notAfterText}`));
});

test('证书与卷同生命周期：重启不重新生成，换 env 也不换证书',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-tls-persist-'));
  const first=await spawnHost({dir,tlsEnv:{ALONG_TLS_CN:'along.example.com',ALONG_TLS_DAYS:'3650'}});
  t.after(async()=>{await first.stop();rmSync(dir,{recursive:true,force:true});});
  const fingerprint=certInfo(join(dir,'cert.pem')).fingerprint;
  await first.stop();
  const second=await spawnHost({dir,tlsEnv:{ALONG_TLS_CN:'other.example.com'}});
  t.after(async()=>{await second.stop();});
  assert.equal(certInfo(join(dir,'cert.pem')).fingerprint,fingerprint,
    '证书已存在就不重新生成（换证书须删 cert/key 重启，§6.4 步骤 10）');
  assert.match(second.text(),/证书到期: /,'重启横幅照常打印到期时间');
});
