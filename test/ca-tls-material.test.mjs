import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,chmodSync,chownSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,X509Certificate} from 'node:crypto';
import {loadCloudTlsMaterial,certificateCoversHost,publicDigest,spkiDigest} from '../host/tls-material.mjs';
import {buildRootProfile,verifyRootProfile,profileDigest,rootDerFromPem} from '../host/ca-profile.mjs';

// 云端 CA 叶证书与只含公开根的描述文件（docs/iphone-ca-profile-design.md §3.1/§3.2/§8 T02/T05/T09）。
//
// 全部使用隔离测试 CA：测试自己生成根与叶，不接触任何生产材料，也不生成生产密钥。
// 这里验证的是「加载与校验」逻辑——真机安装、完全信任与系统评估不在自动化范围内。

function openssl(args,cwd) {
  return execFileSync('openssl',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
}

// 生成一套隔离测试 CA：根 + 带 SAN 的叶。所有扩展显式写出，不依赖 OpenSSL 默认行为
// （docs/iphone-ca-profile-design.md §10：默认扩展随版本与配置变化）。
function makeTestCa(root) {
  mkdirSync(root,{recursive:true});
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','3650',
    '-subj','/CN=Along Test Root CA',
    '-addext','basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext','keyUsage=critical,keyCertSign,cRLSign'],root);
  openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.csr',
    '-subj','/CN=along.test.local'],root);
  writeFileSync(join(root,'ext.cnf'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:along.test.local\n');
  openssl(['x509','-req','-in','leaf.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial',
    '-out','leaf.crt','-days','90','-extfile','ext.cnf'],root);
  return {root};
}

// 铺一套符合目录契约的云端证书版本目录：tls/releases/<serial>/ + tls/current 符号链接。
function stageRelease(stateDir,ca,{serial='test-1',host='along.test.local'}={}) {
  const releases=join(stateDir,'tls','releases');
  const version=join(releases,serial);
  mkdirSync(version,{recursive:true,mode:0o700});
  writeFileSync(join(version,'fullchain.pem'),readFileSync(join(ca.root,'leaf.crt')));
  writeFileSync(join(version,'key.pem'),readFileSync(join(ca.root,'leaf.key')));
  writeFileSync(join(version,'root.crt'),readFileSync(join(ca.root,'ca.crt')));
  chmodSync(join(version,'key.pem'),0o600);
  chmodSync(join(version,'fullchain.pem'),0o644);
  chmodSync(join(version,'root.crt'),0o644);
  chmodSync(version,0o700);
  const current=join(stateDir,'tls','current');
  if(existsSync(current)) rmSync(current,{force:true});
  symlinkSync(version,current);
  return version;
}

function fixture(t) {
  const base=mkdtempSync(join(tmpdir(),'along-ca-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const ca=makeTestCa(join(base,'ca'));
  const stateDir=join(base,'data');
  mkdirSync(stateDir,{recursive:true,mode:0o700});
  return {base,ca,stateDir};
}

test('云端加载：SAN 覆盖的叶证书被接受，并给出可核对的公开身份',t=>{
  const f=fixture(t);
  stageRelease(f.stateDir,f.ca);
  const material=loadCloudTlsMaterial({stateDir:f.stateDir,host:'along.test.local'});
  assert.equal(material.serial,'test-1');
  assert.equal(material.leaf.subjectAltName,'DNS:along.test.local');
  // 指纹是叶证书 DER 的 SHA-256；与根的 DER 摘要不是同一个身份。
  assert.equal(material.fingerprint,publicDigest(material.leaf).toUpperCase());
  assert.notEqual(publicDigest(material.leaf),publicDigest(material.root));
  assert.equal(spkiDigest(material.leaf).length,64);
  assert.ok(material.notAfter);
});

test('云端加载：SAN 不覆盖期望主机就拒启，不静默放行',t=>{
  const f=fixture(t);
  stageRelease(f.stateDir,f.ca);
  assert.throws(()=>loadCloudTlsMaterial({stateDir:f.stateDir,host:'other.test.local'}),/SAN/);
});

test('云端加载：缺证书、缺 current 链接、非链接 current 一律拒启（不自签兜底）',t=>{
  const f=fixture(t);
  assert.throws(()=>loadCloudTlsMaterial({stateDir:f.stateDir,host:'along.test.local'}),/tls\/current/);
  stageRelease(f.stateDir,f.ca);
  // 把 current 换成真实目录（不是符号链接）——契约要求原子切换用的链接。
  const current=join(f.stateDir,'tls','current');
  rmSync(current,{force:true});
  mkdirSync(current,{recursive:true});
  assert.throws(()=>loadCloudTlsMaterial({stateDir:f.stateDir,host:'along.test.local'}),/符号链接/);
});

test('云端加载：证书与私钥不匹配、过期、权限过宽都拒启',t=>{
  const f=fixture(t);
  const version=stageRelease(f.stateDir,f.ca);
  // 换成另一把私钥 → 证书与私钥不匹配。
  openssl(['genrsa','-out','other.key','2048'],f.ca.root);
  writeFileSync(join(version,'key.pem'),readFileSync(join(f.ca.root,'other.key')));
  chmodSync(join(version,'key.pem'),0o600);
  assert.throws(()=>loadCloudTlsMaterial({stateDir:f.stateDir,host:'along.test.local'}),/不匹配|无法解析/);
  // 私钥权限过宽 → 拒启。
  writeFileSync(join(version,'key.pem'),readFileSync(join(f.ca.root,'leaf.key')));
  chmodSync(join(version,'key.pem'),0o644);
  assert.throws(()=>loadCloudTlsMaterial({stateDir:f.stateDir,host:'along.test.local'}),/权限/);
});

test('云端加载：过期叶证书拒启',t=>{
  const f=fixture(t);
  const version=stageRelease(f.stateDir,f.ca);
  // 用「未来时刻」作为当前时间：证书的有效期在真实当下，但相对注入的 now 已过期。
  assert.throws(()=>loadCloudTlsMaterial({stateDir:f.stateDir,host:'along.test.local',now:new Date('2099-01-01')}),/有效期/);
  assert.ok(existsSync(version));
});

test('云端加载：服务器上不该出现根私钥',t=>{
  const f=fixture(t);
  const version=stageRelease(f.stateDir,f.ca);
  writeFileSync(join(version,'ca.key'),readFileSync(join(f.ca.root,'ca.key')));
  assert.throws(()=>loadCloudTlsMaterial({stateDir:f.stateDir,host:'along.test.local'}),/根私钥/);
});

test('云端加载：根私钥按内容判定——改名或放子目录都躲不掉',t=>{
  // 复核报告实测：旧的按文件名黑名单（/ca\.key|root\.key/i）漏掉改名与子目录两种放法。
  // 判定改成「任何 PEM 私钥的公钥与公开根相同即视为根私钥上服务器」。
  const cases=[
    {name:'renamed',place:(version,caDir)=>writeFileSync(join(version,'root-ca-private.pem'),readFileSync(join(caDir,'ca.key')))},
    {name:'subdir',place:(version,caDir)=>{
      mkdirSync(join(version,'backup'),{recursive:true,mode:0o700});
      writeFileSync(join(version,'backup','ca.key'),readFileSync(join(caDir,'ca.key')));
    }},
  ];
  for(const {name,place} of cases) {
    const f=fixture(t);
    const version=stageRelease(f.stateDir,f.ca);
    place(version,f.ca.root);
    assert.throws(()=>loadCloudTlsMaterial({stateDir:f.stateDir,host:'along.test.local'}),/根私钥/,
      name+' 放法必须被识别为根私钥上服务器');
  }
});

test('云端加载：叶私钥不是根私钥，正常材料不被误判',t=>{
  // 内容判定不能把正常的叶私钥当成根私钥——叶私钥本来就在服务器上。
  const f=fixture(t);
  stageRelease(f.stateDir,f.ca);
  assert.doesNotThrow(()=>loadCloudTlsMaterial({stateDir:f.stateDir,host:'along.test.local'}));
});

test('云端加载：证书材料的所有者必须是 Host 用户',t=>{
  // 设计 §3.1 要求「所有者为实际 Host 用户」；属主不对意味着别人能换掉服务器出示的证书。
  const f=fixture(t);
  const version=stageRelease(f.stateDir,f.ca);
  // 用另一个 uid 拥有私钥：模拟「材料是别人放进去的」。
  const otherUid=process.getuid?.()===0?65534:0;
  if(process.getuid?.()===undefined||process.getuid()!==0) {
    // 非 root 环境无法改属主（chown 需要权限）：属主断言无法在此环境验证，
    // 但权限检查路径仍要走到——这里验证权限过宽被拒。
    chmodSync(join(version,'key.pem'),0o644);
    assert.throws(()=>loadCloudTlsMaterial({stateDir:f.stateDir,host:'along.test.local'}),/权限过宽/);
    return;
  }
  chownSync(join(version,'key.pem'),otherUid,process.getgid());
  assert.throws(()=>loadCloudTlsMaterial({stateDir:f.stateDir,host:'along.test.local'}),/所有者/);
});

test('SAN 覆盖：通配符只匹配最左侧单层，IP SAN 与 DNS SAN 不互相冒充',t=>{
  const f=fixture(t);
  const leaf=new X509Certificate(readFileSync(join(f.ca.root,'leaf.crt')));
  assert.equal(certificateCoversHost(leaf,'along.test.local'),true);
  assert.equal(certificateCoversHost(leaf,'ALONG.TEST.LOCAL'),true);
  assert.equal(certificateCoversHost(leaf,'other.test.local'),false);
  assert.equal(certificateCoversHost(leaf,'127.0.0.1'),false);
});

test('描述文件：只含一个根 payload，嵌入根与批准根一致，摘要可核对',t=>{
  const f=fixture(t);
  const rootDer=rootDerFromPem(readFileSync(join(f.ca.root,'ca.crt'),'utf8'));
  const profile=buildRootProfile({rootDer,environment:'test',rootId:'abc123'});
  const verified=verifyRootProfile({profileXml:profile.xml,rootDer});
  assert.equal(verified.rootDER,createHash('sha256').update(rootDer).digest('hex'));
  assert.equal(verified.rootSPKI.length,64);
  assert.match(profile.identifier,/^com\.artstur\.along\.ca\.test\.abc123$/);
  // 描述文件字节摘要与根 DER 摘要是两个不同身份，不能混用。
  assert.notEqual(profileDigest(profile.xml),verified.rootDER);
  assert.match(profile.xml,/<key>PayloadType<\/key>\s*<string>com\.apple\.security\.root<\/string>/);
  assert.doesNotMatch(profile.xml,/com\.apple\.vpn\./);
});

test('描述文件：嵌入别的根就核验失败（不能只凭同名 CN 通过）',t=>{
  const f=fixture(t);
  const other=makeTestCa(join(f.base,'other'));
  const rootDer=rootDerFromPem(readFileSync(join(f.ca.root,'ca.crt'),'utf8'));
  const otherDer=rootDerFromPem(readFileSync(join(other.root,'ca.crt'),'utf8'));
  const profile=buildRootProfile({rootDer:otherDer,environment:'test',rootId:'abc123'});
  assert.throws(()=>verifyRootProfile({profileXml:profile.xml,rootDer}),/不一致/);
});

test('描述文件：夹带额外 payload 就被拒绝',t=>{
  const f=fixture(t);
  const rootDer=rootDerFromPem(readFileSync(join(f.ca.root,'ca.crt'),'utf8'));
  const profile=buildRootProfile({rootDer,environment:'test',rootId:'abc123'});
  const tampered=profile.xml.replace('</array>',
    '  <dict><key>PayloadType</key><string>com.apple.vpn.managed</string></dict>\n  </array>');
  assert.throws(()=>verifyRootProfile({profileXml:tampered,rootDer}),/不该存在的 payload/);
});

test('描述文件：白名单而非黑名单——无后缀的真实 payload 类型也一律拒绝',t=>{
  // 复核报告实测：旧黑名单要求「点号后还有内容」，漏掉 Apple 真实的无后缀类型名。
  // com.apple.security.pkcs12 尤其要紧——它能携带客户端身份与私钥。
  const f=fixture(t);
  const rootDer=rootDerFromPem(readFileSync(join(f.ca.root,'ca.crt'),'utf8'));
  const profile=buildRootProfile({rootDer,environment:'test',rootId:'abc123'});
  for(const type of ['com.apple.security.pkcs12','com.apple.security.scep','com.apple.identityPreference',
    'com.apple.webClip.managed','com.apple.vpn.managed','com.apple.proxy.http.global','com.apple.mdm']) {
    const tampered=profile.xml.replace('</array>',
      '  <dict><key>PayloadType</key><string>'+type+'</string></dict>\n  </array>');
    assert.throws(()=>verifyRootProfile({profileXml:tampered,rootDer}),/不该存在的 payload/,
      '夹带 '+type+' 必须被拒绝');
  }
});

test('描述文件：PayloadContent 里多塞一个 payload 槽位也被拒绝',t=>{
  const f=fixture(t);
  const rootDer=rootDerFromPem(readFileSync(join(f.ca.root,'ca.crt'),'utf8'));
  const profile=buildRootProfile({rootDer,environment:'test',rootId:'abc123'});
  // 复制一份同类型的根 payload：PayloadType 白名单放行，但 payload 槽位必须只有一个。
  const rootPayload=profile.xml.match(/<dict>\s*<key>PayloadCertificateFileName<\/key>[\s\S]*?<\/dict>/)[0];
  const tampered=profile.xml.replace('</array>','  '+rootPayload+'\n  </array>');
  assert.throws(()=>verifyRootProfile({profileXml:tampered,rootDer}),/必须且只能含一个根证书 payload/);
});

test('描述文件：可以移除，不设置不可移除限制',t=>{
  const f=fixture(t);
  const rootDer=rootDerFromPem(readFileSync(join(f.ca.root,'ca.crt'),'utf8'));
  const profile=buildRootProfile({rootDer,environment:'test',rootId:'abc123'});
  assert.match(profile.xml,/<key>PayloadRemovalDisallowed<\/key>\s*<false\/>/);
});

