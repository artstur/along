// 云端 TLS 证书材料加载与启动前校验（docs/iphone-ca-profile-design.md §3.1/§7「服务端 TLS」）。
//
// 本模块只做一件事：把「预签发的 CA 叶证书」从磁盘读出来，并证明它可用于当前云端主机名。
// 它不生成密钥、不签发证书、不读取根私钥；根私钥只存在于离线保管链，永远不到这台机器。
//
// 设计要点（与设计文档 §3.1 对齐）：
// - 证书版本目录 <stateDir>/tls/releases/<serial>/ 内含 fullchain.pem、key.pem 与公开 root.crt；
//   tls/current 是指向某个版本目录的符号链接，切换是原子的（rename 覆盖链接）。
// - 校验项：叶私钥与叶证书配对、链可验签到根、SAN 覆盖期望 DNS 主机、EKU 含 serverAuth、
//   CA:FALSE、当前时间落在有效期内、私钥与证书文件权限不超出 0600/目录 0700。
// - 任一项不满足就抛错，让 Host 在监听前拒启——云端不回退到现场自签。
//
// 本地单用户形态（Mac）不走本模块：host/agent-host.mjs 保留既有自签逻辑，行为不变。

import {X509Certificate,createPrivateKey,createPublicKey,createHash} from 'node:crypto';
import {readFileSync,statSync,lstatSync,readdirSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve,basename,sep} from 'node:path';

// SAN 里的 host 名单（只认 DNS 与 IP 两类；othername / URI 不接受）。
function sanNames(cert) {
  const out=[];
  const raw=cert.subjectAltName;
  if(typeof raw!=='string') return out;
  for (const part of raw.split(',')) {
    const text=part.trim();
    if(text.startsWith('DNS:')) out.push({kind:'DNS',value:text.slice(4).toLowerCase()});
    // 'IP Address:' 是 11 个字符：少切一位会留下前导冒号，IP SAN 永远匹配不上。
    else if(text.startsWith('IP Address:')) out.push({kind:'IP',value:text.slice('IP Address:'.length).trim()});
  }
  return out;
}

// 通配符只允许最左侧单个 label：*.example.com 匹配 a.example.com，不匹配 a.b.example.com。
function dnsMatches(pattern,host) {
  if(pattern===host) return true;
  if(!pattern.startsWith('*.')) return false;
  const suffix=pattern.slice(1); // ".example.com"
  if(!host.endsWith(suffix)) return false;
  const label=host.slice(0,host.length-suffix.length);
  return label.length>0&&!label.includes('.');
}

export function certificateCoversHost(cert,host) {
  const names=sanNames(cert);
  const lower=String(host??'').toLowerCase();
  if(!lower) return false;
  const isIP=/^[0-9.]+$/.test(lower)||lower.includes(':');
  return names.some(name=>name.kind==='IP'&&isIP
    ? name.value===lower
    : name.kind==='DNS'&&!isIP&&dnsMatches(name.value,lower));
}

// 权限检查：私钥 0600（不含组/其他位），证书 0644 即可，目录 0700。
// 所有者检查：设计 §3.1 要求「所有者为实际 Host 用户」。属主不对的证书材料不能被加载——
// 别人能改的文件意味着别人能换掉服务器出示的证书。
function checkPermissions(dir,keyFile,certFile,uid) {
  const problems=[];
  const dirStat=lstatSync(dir);
  if(!dirStat.isDirectory()||dirStat.isSymbolicLink()) problems.push('证书版本目录不是普通目录');
  if((dirStat.mode&0o077)!==0) problems.push('证书版本目录权限过宽');
  if(uid!==undefined&&dirStat.uid!==uid) problems.push('证书版本目录的所有者不是 Host 用户');
  const keyStat=lstatSync(keyFile);
  if(!keyStat.isFile()||keyStat.isSymbolicLink()) problems.push('私钥不是普通文件');
  if((keyStat.mode&0o077)!==0) problems.push('私钥权限过宽');
  if(uid!==undefined&&keyStat.uid!==uid) problems.push('私钥的所有者不是 Host 用户');
  const certStat=lstatSync(certFile);
  if(!certStat.isFile()||certStat.isSymbolicLink()) problems.push('证书不是普通文件');
  if(uid!==undefined&&certStat.uid!==uid) problems.push('证书的所有者不是 Host 用户');
  return problems;
}

// 解析 PEM 链：按 BEGIN/END CERTIFICATE 块切分。fullchain 至少要有叶。
function parseChain(pem) {
  const blocks=[];
  const re=/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  let match;
  while((match=re.exec(pem))!==null) blocks.push(match[1].replace(/\s+/g,''));
  return blocks.map(body=>new X509Certificate(Buffer.from(body,'base64')));
}

// 根私钥绝不出现在服务器：这里只核对公开根证书，服务器只持有叶私钥。
//
// 判定按内容而不是按文件名（复核报告实测：改名或放子目录就能绕过按名字的黑名单）：
// 递归扫描版本目录里的每一个 PEM 私钥，只要它的公钥与公开根的公钥相同，
// 就说明根私钥被搬到了服务器上——无论它叫什么名字、放在哪一层。
//
// 扫描范围是整个 tls/releases/ 目录树（不只是 tls/current 指向的那一个版本）：
// 复核报告实测——根私钥放在兄弟版本目录里能通过，因为旧实现只扫当前版本。
// 符号链接也要跟进：版本目录里的符号链接同样算「在这个目录里」。
function assertNoRootKey(dir,root) {
  const rootPublicKey=root.publicKey.export({type:'spki',format:'der'});
  const suspicious=[];
  for(const entry of walkFiles(dir)) {
    let text;
    try { text=readFileSync(entry,'utf8'); }
    catch { continue; } // 二进制或不可读的文件不参与判定。
    if(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) continue;
    for(const pem of text.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g)||[]) {
      let key;
      try { key=createPrivateKey(pem); }
      catch { continue; } // 不是本机支持的私钥格式：不是根私钥，也不是我们的叶私钥。
      let publicKey;
      try { publicKey=createPublicKey(key).export({type:'spki',format:'der'}); }
      catch { continue; }
      if(publicKey.equals(rootPublicKey)) suspicious.push(entry);
    }
  }
  if(suspicious.length) throw Error('证书版本目录里不应出现根私钥文件');
}

// 递归列出目录下的文件。
//
// 符号链接：跟随它指向的文件（复核报告实测——根私钥以符号链接放在版本目录内能通过，
// 因为旧实现直接跳过符号链接）。链接本身不重复计入，避免同一文件被算两次；
// 指向目录的链接按目录递归，指向文件的链接按文件读。
function walkFiles(dir,seen=new Set()) {
  const files=[];
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
    const full=join(dir,entry.name);
    if(entry.isSymbolicLink()) {
      let target;
      try { target=realpathSync(full); }
      catch { continue; } // 断链：读不到，不参与判定。
      if(seen.has(target)) continue;
      seen.add(target);
      let stats;
      try { stats=statSync(target); }
      catch { continue; }
      if(stats.isDirectory()) files.push(...walkFiles(target,seen));
      else if(stats.isFile()) files.push(full);
      continue;
    }
    if(entry.isDirectory()) files.push(...walkFiles(full,seen));
    else if(entry.isFile()) files.push(full);
  }
  return files;
}

/**
 * 加载并校验云端当前 TLS 材料。
 *
 * stateDir: 状态目录（/data）
 * host: 期望的 DNS 主机名（云端域名）
 * now: 当前时间（测试可注入）
 */
export function loadCloudTlsMaterial({stateDir,host,now=new Date()}) {
  if(typeof stateDir!=='string'||!stateDir) throw Error('云端 TLS 需要状态目录');
  if(typeof host!=='string'||!host.trim()) throw Error('云端 TLS 需要期望主机名');
  const tlsRoot=join(resolve(stateDir),'tls');
  const current=join(tlsRoot,'current');
  if(!existsSync(current)) throw Error('云端 TLS 缺少证书版本目录 tls/current');
  // current 必须是符号链接（原子切换），且解析后必须落在 tls/releases/ 之内。
  const linkStat=lstatSync(current);
  if(!linkStat.isSymbolicLink()) throw Error('云端 TLS 的 tls/current 必须是符号链接');
  const target=realpathSync(current);
  const releases=realpathSync(join(tlsRoot,'releases'));
  if(!target.startsWith(releases+sep)) throw Error('云端 TLS 的 tls/current 指向版本目录之外');
  const serial=basename(target);
  // 根私钥检查覆盖整个 releases/ 树：兄弟版本目录里的材料同样是这台服务器上的材料。
  const releasesDir=join(tlsRoot,'releases');
  if(!/^[A-Za-z0-9._-]{1,64}$/.test(serial)) throw Error('云端 TLS 版本目录名不合法');
  const keyFile=join(target,'key.pem');
  const certFile=join(target,'fullchain.pem');
  const rootFile=join(target,'root.crt');
  for(const file of [keyFile,certFile,rootFile]) if(!existsSync(file)) throw Error(`云端 TLS 缺少文件 ${basename(file)}`);
  // 根私钥检查需要公开根（按公钥比对，不靠文件名猜测）。
  const root=new X509Certificate(readFileSync(rootFile));
  assertNoRootKey(releasesDir,root);
  const permissionProblems=checkPermissions(target,keyFile,certFile,process.getuid?.());
  if(permissionProblems.length) throw Error(`云端 TLS 材料不合规：${permissionProblems.join('、')}`);

  const key=readFileSync(keyFile);
  const cert=readFileSync(certFile);
  const chain=parseChain(cert);
  if(!chain.length) throw Error('云端 TLS 的 fullchain.pem 里没有证书');
  const leaf=chain[0];
  if(leaf.ca) throw Error('云端 TLS 叶证书不能是 CA');
  const eku=leaf.toLegacyObject().ext_key_usage;
  if(!Array.isArray(eku)||!eku.includes('1.3.6.1.5.5.7.3.1')) throw Error('云端 TLS 叶证书缺少 serverAuth 用途');
  const notBefore=new Date(leaf.validFrom),notAfter=new Date(leaf.validTo);
  if(!(now>=notBefore&&now<=notAfter)) throw Error('云端 TLS 叶证书不在有效期内');
  if(!root.ca) throw Error('云端 TLS 根证书不是 CA');
  if(!leaf.verify(root.publicKey)) throw Error('云端 TLS 叶证书不能验签到根证书');
  // 链上其余证书必须逐级可验（本期根直接签叶，链长 1 或 2 都可以）。
  for(let index=1;index<chain.length;index++) {
    const issuer=chain[index];
    if(!chain[index-1].verify(issuer.publicKey)) throw Error('云端 TLS 证书链无法逐级验签');
  }
  if(chain.length>1&&!chain[chain.length-1].verify(root.publicKey)) throw Error('云端 TLS 证书链末尾不能验签到根证书');
  if(!certificateCoversHost(leaf,host)) throw Error(`云端 TLS 叶证书的 SAN 不覆盖 ${host}`);
  let privateKey;
  try { privateKey=createPrivateKey(key); }
  catch { throw Error('云端 TLS 私钥无法解析'); }
  if(!leaf.checkPrivateKey(privateKey)) throw Error('云端 TLS 叶证书与私钥不匹配');

  return {
    key,cert,leaf,root,serial,directory:target,
    fingerprint:createHash('sha256').update(leaf.raw).digest('hex').toUpperCase(),
    notAfter:notAfter.toISOString(),
  };
}

// 供测试与工具复用的公开摘要（DER SHA-256 与 SPKI SHA-256 语义不同，不能混用）。
export function publicDigest(cert) {
  return createHash('sha256').update(cert.raw).digest('hex');
}

export function spkiDigest(cert) {
  return createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest('hex');
}
