// 只含公开根证书的 iPhone 描述文件制作与核验
// （docs/iphone-ca-profile-design.md §3.2「描述文件仅含公开根」、§4.1「带外核验与分发」）。
//
// 本模块只处理公开材料：根证书（DER/PEM）、描述文件 XML plist、以及核验用的摘要。
// 它不生成根私钥、不签发叶证书、不安装描述文件——那些属于离线 CA 保管机与管理员动作。
//
// 描述文件结构按 Apple CertificateRoot payload：
//   外层 PayloadType=Configuration，PayloadContent 里只有一个 com.apple.security.root，
//   其 PayloadContent 是根证书 DER 的 base64（不是 PEM 文本，也不是 PKCS#12）。
// 不夹带 VPN/代理/MDM/SCEP/账号/WebClip/客户端身份等任何其他 payload。

import {X509Certificate,createHash,randomUUID} from 'node:crypto';

// XML 转义：plist 文本节点里 & < > 必须转义，否则生成的 XML 不可解析。
function xmlEscape(value) {
  return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// 描述文件标识只用安全字符，避免注入到 PayloadIdentifier 里。
function safeId(value,fallback) {
  const text=String(value??'').replace(/[^A-Za-z0-9._-]/g,'-').slice(0,64);
  return text||fallback;
}

/**
 * 生成只含公开根的 .mobileconfig（XML plist）。
 *
 * rootDer: 根证书 DER 字节
 * environment: 环境标识（生产/测试），进 PayloadIdentifier 与显示名
 * rootId: 根的显示标识（建议用 DER SHA-256 前缀），只作显示，核验必须用完整摘要
 */
export function buildRootProfile({rootDer,environment,rootId}) {
  if(!Buffer.isBuffer(rootDer)||!rootDer.length) throw Error('描述文件需要根证书 DER');
  if(typeof environment!=='string'||!environment.trim()) throw Error('描述文件需要环境标识');
  const env=safeId(environment,'env');
  const id=safeId(rootId,'root');
  const profileUUID=randomUUID().toUpperCase();
  const rootUUID=randomUUID().toUpperCase();
  const identifier=`com.artstur.along.ca.${env}.${id}`;
  const displayName=`Along ${environment} CA ${id}`;
  const xml=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>Along-${env}-${id}.cer</string>
      <key>PayloadContent</key>
      <data>
${base64Lines(rootDer)}
      </data>
      <key>PayloadDescription</key>
      <string>Installs the Along ${environment} CA root certificate for TLS trust only.</string>
      <key>PayloadDisplayName</key>
      <string>${xmlEscape(displayName)}</string>
      <key>PayloadIdentifier</key>
      <string>com.artstur.along.ca.root.${env}.${id}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${rootUUID}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>${xmlEscape(displayName)}</string>
  <key>PayloadIdentifier</key>
  <string>${xmlEscape(identifier)}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileUUID}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
  return {xml,identifier,displayName,profileUUID,rootUUID};
}

function base64Lines(buffer) {
  const base64=buffer.toString('base64');
  const lines=[];
  for(let index=0;index<base64.length;index+=64) lines.push(base64.slice(index,index+64));
  return lines.join('\n');
}

/**
 * 解析描述文件并核验其中嵌入的根是否与给定的根 DER 一致。
 *
 * 只做结构与身份核验，不做真实性判断——XML 未签名的描述文件，真实性依赖带外摘要比对
 * （docs/iphone-ca-profile-design.md §4.1）。这里返回的是「结构合规 + 嵌入根一致」。
 */
export function verifyRootProfile({profileXml,rootDer}) {
  if(typeof profileXml!=='string'||!profileXml.trim()) throw Error('缺少描述文件内容');
  // 白名单而不是黑名单（docs/iphone-ca-profile-design.md §3.2）：描述文件里只允许两种
  // PayloadType——外层的 Configuration 与唯一一个 com.apple.security.root。
  // 黑名单（com.apple.vpn.* 之类）漏掉了 Apple 真实的无后缀类型名
  // （com.apple.security.pkcs12、com.apple.security.scep、com.apple.identityPreference…），
  // 而 pkcs12 能携带客户端身份与私钥——所以这里逐个枚举出现过的 PayloadType，
  // 出现任何白名单之外的类型一律拒绝。
  const ALLOWED_PAYLOAD_TYPES=new Set(['Configuration','com.apple.security.root']);
  const payloadTypes=[...profileXml.matchAll(/<key>PayloadType<\/key>\s*<string>([^<]*)<\/string>/g)].map(match=>match[1].trim());
  if(!payloadTypes.length) throw Error('描述文件缺少 PayloadType');
  for(const type of payloadTypes) {
    if(!ALLOWED_PAYLOAD_TYPES.has(type)) throw Error(`描述文件里出现了不该存在的 payload：${type}`);
  }
  const rootCount=payloadTypes.filter(type=>type==='com.apple.security.root').length;
  if(rootCount!==1) throw Error('描述文件必须且只能含一个根证书 payload');
  // 外层 Configuration 恰好一个（顶层类型），根 payload 挂在它的 PayloadContent 数组里。
  if(payloadTypes.filter(type=>type==='Configuration').length!==1) throw Error('描述文件必须且只能有一个外层 Configuration');
  // 按 PayloadContent 数组的元素个数核对：只允许一个 payload 槽位。
  const contentMatch=profileXml.match(/<key>PayloadContent<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if(!contentMatch) throw Error('描述文件缺少 PayloadContent 数组');
  const payloadEntries=[...contentMatch[1].matchAll(/<key>PayloadType<\/key>/g)].length;
  if(payloadEntries!==1) throw Error(`描述文件的 PayloadContent 必须只含一个 payload，实际含 ${payloadEntries} 个`);
  const dataMatch=profileXml.match(/<key>PayloadContent<\/key>\s*<data>\s*([\s\S]*?)\s*<\/data>/);
  if(!dataMatch) throw Error('描述文件缺少 PayloadContent 数据');
  const embedded=Buffer.from(dataMatch[1].replace(/\s+/g,''),'base64');
  if(!Buffer.isBuffer(rootDer)||!rootDer.length) throw Error('缺少用于比对的根证书');
  if(!embedded.equals(rootDer)) throw Error('描述文件里嵌入的根证书与批准的根不一致');
  const cert=new X509Certificate(embedded);
  if(!cert.ca) throw Error('嵌入的证书不是 CA 根');
  return {
    rootDER:createHash('sha256').update(embedded).digest('hex'),
    rootSPKI:createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest('hex'),
    serialNumber:cert.serialNumber,
    notBefore:cert.validFrom,
    notAfter:cert.validTo,
    subject:cert.subject,
  };
}

// 描述文件字节摘要（与根 DER 摘要是两个不同身份，不能混用）。
export function profileDigest(profileXml) {
  return createHash('sha256').update(Buffer.from(profileXml,'utf8')).digest('hex');
}

export function rootDerFromPem(pem) {
  const match=String(pem).match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if(!match) throw Error('不是有效的 PEM 证书');
  return Buffer.from(match[1].replace(/\s+/g,''),'base64');
}

