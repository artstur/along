// 云端 CA 证书材料的测试夹具（docs/iphone-ca-profile-design.md §3.1）。
//
// 云端形态（Host 配置了云端 Runner）必须加载预签发的 CA 叶证书，缺失就拒启——
// 这是设计要求，不是测试便利。所以凡是启动云端 Host 的测试都要先铺一套隔离测试 CA。
//
// 这里生成的都是一次性的测试材料：测试自己的根与叶，装在临时目录里，
// 既不接触生产材料，也不生成任何生产密钥。

import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,symlinkSync,chmodSync,mkdtempSync,renameSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {isIP} from 'node:net';

function openssl(args,cwd) {
  return execFileSync('openssl',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
}

// 生成隔离测试 CA：根 + 带 SAN 的叶。所有扩展显式写出，不依赖 OpenSSL 默认行为
// （docs/iphone-ca-profile-design.md §10：默认扩展随版本与配置变化）。
export function makeTestCa(root,host='along.test.local') {
  mkdirSync(root,{recursive:true});
  // A machine's req.x509_extensions plus -addext can duplicate the same OIDs.
  // Own the complete config and select one section instead of layering defaults.
  writeFileSync(join(root,'ca.cnf'),
    '[req]\ndistinguished_name=dn\n[dn]\n[root_ca]\n'+
    'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n'+
    'subjectKeyIdentifier=hash\n');
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','3650',
    '-subj','/CN=Along Test Root CA','-config','ca.cnf','-extensions','root_ca'],root);
  openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj',`/CN=${host}`],root);
  writeFileSync(join(root,'ext.cnf'),
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${isIP(host)?'IP':'DNS'}:${host}\n`);
  openssl(['x509','-req','-in','leaf.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial',
    '-out','leaf.crt','-days','90','-extfile','ext.cnf'],root);
  return root;
}

// 铺一套符合目录契约的云端证书版本目录：tls/releases/<serial>/ + tls/current 符号链接。
//
// leafDir：换叶时指向**新叶**的目录（由 rotateLeaf 产出）；默认用 ca 目录里的
// leaf.crt / leaf.key。根始终是 ca/ca.crt —— 同根同域换叶（CA 方案 §6）
// 不需要重新装机，因为手机信任的是根。
export function stageRelease(stateDir,ca,{serial='test-1',leafDir}={}) {
  const source=leafDir??ca;
  const version=join(stateDir,'tls','releases',serial);
  mkdirSync(version,{recursive:true,mode:0o700});
  writeFileSync(join(version,'fullchain.pem'),readFileSync(join(source,'leaf.crt')));
  writeFileSync(join(version,'key.pem'),readFileSync(join(source,'leaf.key')));
  writeFileSync(join(version,'root.crt'),readFileSync(join(ca,'ca.crt')));
  chmodSync(join(version,'key.pem'),0o600);
  chmodSync(join(version,'fullchain.pem'),0o644);
  chmodSync(join(version,'root.crt'),0o644);
  chmodSync(version,0o700);
  const tls=join(stateDir,'tls');
  const staging=mkdtempSync(join(tls,'.switch-'));
  const link=join(staging,'current');
  // 相对目标在 bind mount 内仍有效。同文件系统 rename 原子替换旧链接。
  symlinkSync(join('releases',serial),link);
  renameSync(link,join(tls,'current'));
  rmdirSync(staging);
  return version;
}

// 同根同域换叶（CA 方案 §6 的轮换口径）：用**同一个根**签一张新叶。
// 手机信任的是根，所以换叶不必重新装机；换根才需要逐台撤根。
export function rotateLeaf(root,host='along.test.local',serial='rotated-1') {
  const dir=join(root,`leaf-${serial}`);
  mkdirSync(dir,{recursive:true});
  openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',join(dir,'leaf.key'),
    '-out',join(dir,'leaf.csr'),'-subj',`/CN=${host}`],root);
  writeFileSync(join(dir,'ext.cnf'),
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${isIP(host)?'IP':'DNS'}:${host}\n`);
  openssl(['x509','-req','-in',join(dir,'leaf.csr'),'-CA',join(root,'ca.crt'),'-CAkey',join(root,'ca.key'),
    '-CAcreateserial','-out',join(dir,'leaf.crt'),'-days','90','-extfile',join(dir,'ext.cnf')],root);
  return dir;
}

// 一步到位：给一个云端状态目录铺好测试 CA 材料，返回可用的主机名。
export function provideCloudCa(stateDir,{host='along.test.local',serial='test-1',baseDir}={}) {
  // Each state owns its CA; sibling tmp states run concurrently in Node's test runner.
  const ca=makeTestCa(join(baseDir??stateDir,'test-ca'),host);
  stageRelease(stateDir,ca,{serial});
  return {ca,host,serial};
}

