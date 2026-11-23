import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {request as tlsRequest} from 'node:https';
import {connect as tlsConnect} from 'node:tls';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// M4「云端 TLS 与启动参数」独立验收（docs/cloud-deploy-multi-user.md §4 M4、§5 验收 #4，
// 交叉 §3.1 证书与指纹、§3.7 横幅口径、§6.4 步骤 5 横幅冒烟与步骤 10 换证书）。
// 与 test/host-cloud-tls.test.mjs（实现者测试）互补，不重复其 CN/notAfter/指纹/重启不换证的基础断言；
// 这里从文档验收标准独立推导，覆盖其未覆盖的面：
// - ALONG_AGENT_HOST=0.0.0.0 + ALONG_AGENT_PORT 组合可对外服务：横幅精确打印 https://0.0.0.0:<端口>
//   且 loopback TLS 可用（M4 目标第 3 句；验收 #5 冒烟口径 `Along 服务: https://0.0.0.0:4176` 的 host 侧前提，
//   实现者测试全部绑 127.0.0.1，0.0.0.0 传播没人测过）；
// - 配对钉扎输入闭环：服务器 TLS 握手实际出示的叶子证书 == cert.pem == 横幅指纹
//   （§3.1：指纹从 docker logs 读取作为配对表单输入——横幅打印值必须就是服务真正出示的证书）；
// - 非法 ALONG_TLS_DAYS（NaN / 整数但 <1）静默回落 30 天且不抛错：实现者拍板行为
//   （host/agent-host.mjs:43，对齐 failLimitFromEnv/port 的回落风格），文档未定义，此处锁定防回归；
// - 重启换 ALONG_TLS_DAYS 后，到期行打印在用证书的 notAfter 值而不是按新 env 推算
//   （host/agent-host.mjs:52 从证书文件读；实现者测试只断言「有到期行」，按 env 推算的错误实现也能通过它）；
// - 多用户形态（users.json 在场）横幅照样打印地址/指纹/到期且不出现通用码（§3.7 云端口径 × M4 交叉面，
//   实现者测试全部是本地单用户形态）。

const HOST_FILE=fileURLToPath(new URL('../host/agent-host.mjs',import.meta.url));
const DAY_MS=24*3600*1000;

function freePort() {
  return new Promise(resolve=>{
    const server=net.createServer();
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port; server.close(()=>resolve(port));});
  });
}

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

// 手机视角的 TLS 握手（自签证书关校验，等同 App 的 pinning 信任前一步）：取服务器实际出示的
// 叶子证书 DER，独立计算 SHA-256 指纹——横幅指纹必须与它一致才是有效的配对表单输入（§3.1）。
function peerFingerprint(port) {
  return new Promise((resolve,reject)=>{
    const socket=tlsConnect({host:'127.0.0.1',port,rejectUnauthorized:false});
    socket.setTimeout(10_000,()=>socket.destroy(new Error(`TLS 握手超时（10s）@${port}`)));
    socket.once('secureConnect',()=>{
      const der=socket.getPeerCertificate().raw;
      socket.end();
      resolve(createHash('sha256').update(der).digest('hex').toUpperCase());
    });
    socket.once('error',reject);
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

async function spawnHost({dir,agentHost='127.0.0.1',tlsEnv={}}) {
  const port=await freePort();
  const env={...process.env, ALONG_AGENT_STATE_DIR:dir, ALONG_AGENT_HOST:agentHost, ALONG_AGENT_PORT:String(port)};
  // 「不设 TLS env」的场景要先删掉外部环境可能带进来的变量，再按用例覆盖。
  delete env.ALONG_TLS_DAYS; delete env.ALONG_TLS_CN;
  Object.assign(env,tlsEnv);
  const child=spawn(process.execPath,[HOST_FILE],{env,stdio:['ignore','pipe','pipe']});
  const output=[];
  child.stdout.on('data',data=>output.push(String(data)));
  child.stderr.on('data',data=>output.push(String(data)));
  const deadline=Date.now()+20_000;
  let ready=false;
  while (Date.now()<deadline) {
    try { const health=await healthCall(port); if (health.status===200) {ready=true; break;} } catch { /* 还没起来（openssl 生成中） */ }
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  if (!ready && child.exitCode===null && !child.killed) child.kill('SIGKILL');
  // 只断言「起来了」，绑定地址的精确断言归各用例（0.0.0.0 与 127.0.0.1 场景共用本助手）。
  assert.match(output.join(''),/Along 服务: https:\/\//,`Host 进程要起来：${output.join('').slice(0,400)}`);
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

test('ALONG_AGENT_HOST=0.0.0.0 + ALONG_AGENT_PORT 覆盖：横幅精确地址、loopback 可用，出示证书=cert.pem=横幅指纹',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-tls-host-'));
  const host=await spawnHost({dir,agentHost:'0.0.0.0',tlsEnv:{ALONG_TLS_CN:'along.example.com',ALONG_TLS_DAYS:'3650'}});
  t.after(async()=>{await host.stop();rmSync(dir,{recursive:true,force:true});});
  // 绑定地址与端口都取自 env：验收 #5 的冒烟口径 `Along 服务: https://0.0.0.0:<端口>`（这里端口用
  // 自由端口等价验证同一传播路径，443:4176 的映射属 M5 compose）。
  assert.ok(host.text().includes(`Along 服务: https://0.0.0.0:${host.port}`),'横幅打印 ALONG_AGENT_HOST=0.0.0.0 与端口');
  const info=certInfo(join(dir,'cert.pem'));
  assert.equal(info.cn,'along.example.com');
  assert.ok(Math.abs(info.notAfter-(Date.now()+3650*DAY_MS))<3600*1000,`notAfter 应为 +3650 天，实际 ${info.notAfterText}`);
  // 对外服务语义：0.0.0.0 监听下 loopback TLS 握手与 /health 均可用。
  const health=await healthCall(host.port);
  assert.equal(health.status,200,'0.0.0.0 绑定下 /health 经 loopback 可用');
  // 钉扎输入闭环（§3.1）：握手实际出示的叶子证书 == cert.pem == 横幅指纹。
  const served=await peerFingerprint(host.port);
  assert.equal(served,info.fingerprint,'服务器实际出示的证书就是状态目录里的 cert.pem');
  assert.ok(host.text().includes(`证书指纹 SHA-256: ${info.fingerprint}`),'横幅指纹与出示证书一致（配对表单输入有效）');
  assert.ok(host.text().includes(`证书到期: ${info.notAfterText}`),'横幅到期与出示证书一致');
});

test('ALONG_TLS_DAYS=abc（NaN）：不抛错，按默认参数出 30 天 / CN=Along Local Agent 证书',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-tls-badstr-'));
  const host=await spawnHost({dir,tlsEnv:{ALONG_TLS_DAYS:'abc'}});
  t.after(async()=>{await host.stop();rmSync(dir,{recursive:true,force:true});});
  const info=certInfo(join(dir,'cert.pem'));
  assert.equal(info.cn,'Along Local Agent','回落到默认 CN');
  const expected=Date.now()+30*DAY_MS;
  assert.ok(Math.abs(info.notAfter-expected)<3600*1000,`notAfter 应为 +30 天，实际 ${info.notAfterText}`);
  assert.ok(host.text().includes(`证书到期: ${info.notAfterText}`),'误配仍把到期时间打进横幅，冒烟一眼可见');
});

test('ALONG_TLS_DAYS=0（整数但 <1）：不抛错，同样回落 30 天',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-tls-badzero-'));
  const host=await spawnHost({dir,tlsEnv:{ALONG_TLS_DAYS:'0'}});
  t.after(async()=>{await host.stop();rmSync(dir,{recursive:true,force:true});});
  const info=certInfo(join(dir,'cert.pem'));
  assert.equal(info.cn,'Along Local Agent');
  const expected=Date.now()+30*DAY_MS;
  assert.ok(Math.abs(info.notAfter-expected)<3600*1000,`notAfter 应为 +30 天（value>=1 才生效），实际 ${info.notAfterText}`);
});

test('重启换 ALONG_TLS_DAYS：证书不换，到期行打印在用证书的 notAfter（不是按新 env 推算）',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-tls-expiry-'));
  const first=await spawnHost({dir,tlsEnv:{ALONG_TLS_CN:'along.example.com',ALONG_TLS_DAYS:'3650'}});
  t.after(async()=>{await first.stop();rmSync(dir,{recursive:true,force:true});});
  const before=certInfo(join(dir,'cert.pem'));
  await first.stop();
  // 新 env 只设 DAYS=30（未删证书）：若实现改成按 env 推算到期，横幅会打出 now+30d 而不是在用证书的 notAfter。
  const second=await spawnHost({dir,tlsEnv:{ALONG_TLS_DAYS:'30'}});
  t.after(async()=>{await second.stop();});
  assert.equal(certInfo(join(dir,'cert.pem')).fingerprint,before.fingerprint,'换 env 不重新生成证书（§6.4 步骤 10 才换）');
  assert.ok(second.text().includes(`证书指纹 SHA-256: ${before.fingerprint}`),'重启横幅指纹仍是在用证书');
  assert.ok(second.text().includes(`证书到期: ${before.notAfterText}`),'到期行是证书文件的实际 notAfter，与本次 env 无关');
});

test('多用户形态（users.json 在场）：横幅照样打印地址/指纹/到期，且不出现通用码（§3.7）',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-tls-multi-'));
  writeFileSync(join(dir,'users.json'),JSON.stringify([{userId:'u_aaaa1111',label:'A'}]),{mode:0o600});
  const host=await spawnHost({dir,tlsEnv:{ALONG_TLS_CN:'along.example.com',ALONG_TLS_DAYS:'3650'}});
  t.after(async()=>{await host.stop();rmSync(dir,{recursive:true,force:true});});
  const info=certInfo(join(dir,'cert.pem'));
  assert.equal(info.cn,'along.example.com','TLS env 在多用户形态同样生效');
  assert.ok(host.text().includes(`Along 服务: https://127.0.0.1:${host.port}`),'横幅打印绑定地址');
  assert.ok(host.text().includes(`证书指纹 SHA-256: ${info.fingerprint}`),'横幅打印指纹（云端发码配对的指纹输入）');
  assert.ok(host.text().includes(`证书到期: ${info.notAfterText}`),'横幅打印到期时间');
  assert.doesNotMatch(host.text(),/一次性配对码/,'多用户形态不生成、不打印通用码（§3.2/§3.7，M4 横幅与 M1 形态开关共存）');
});
