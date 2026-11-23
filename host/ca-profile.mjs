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

// 一个够用的 XML plist 解析器（只处理描述文件会用到的类型）。
//
// 为什么不用正则数「PayloadType 键出现了几次」：那数的是键，不是数组元素个数。
// 复核报告实测——在 PayloadContent 数组里塞一个没有 PayloadType 键的 dict，
// 键数仍是 1，但数组实际有 2 个元素；正则口径会放行，设计文档 §4.1 的独立
// plistlib 脚本（assert len(payloads) == 1）却会拒绝同一个文件。两个工具口径
// 打架会给出「结构合规」的假结论，所以这里按真正的 plist 结构解析后再判定。
function parsePlist(xml) {

  const source=String(xml);
  let position=0;
  const decode=(text)=>String(text).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
    .replace(/&apos;/g,"'").replace(/&amp;/g,'&');
  // 跳到下一个 <tag>；跳过声明、注释与 doctype。
  // peek=true 时只看不消费——dict/array 的循环要先看清下一个元素再决定怎么解析。
  function nextTag(peek=false) {
    const saved=position;
    while(position<source.length) {
      const start=source.indexOf('<',position);
      if(start<0) return null;
      if(source.startsWith('<!--',start)) {
        const end=source.indexOf('-->',start);
        if(end<0) throw Error('描述文件的 XML 注释未闭合');
        position=end+3;
        continue;
      }
      if(source.startsWith('<?',start)||source.startsWith('<!',start)) {
        const end=source.indexOf('>',start);
        if(end<0) throw Error('描述文件的 XML 声明未闭合');
        position=end+1;
        continue;
      }
      const end=source.indexOf('>',start);
      if(end<0) throw Error('描述文件的 XML 标签未闭合');
      const raw=source.slice(start+1,end).trim();
      const closing=raw.startsWith('/');
      const selfClosing=raw.endsWith('/');
      const body=raw.replace(/^\//,'').replace(/\/$/,'').trim();
      position=end+1;
      if(peek) position=saved;
      return {name:body.split(/\s/)[0],closing,selfClosing};
    }
    if(peek) position=saved;
    return null;
  }
  // 读出一个标签的文本内容（只用于没有子节点的标量）。
  function readText(tagName) {
    const close=`</${tagName}>`;
    const end=source.indexOf(close,position);
    if(end<0) throw Error(`描述文件的 <${tagName}> 未闭合`);
    const raw=source.slice(position,end);
    position=end+close.length;
    return decode(raw);
  }
  function parseValue() {
    const tag=nextTag();
    if(!tag) throw Error('描述文件的 XML 结构不完整');
    if(tag.closing) throw Error('描述文件的 XML 结构不完整');
    // <plist> 只是包装：它的唯一子节点才是真正的顶层字典。
    if(tag.name==='plist') {
      const inner=parseValue();
      const closing=nextTag();
      if(!closing||!closing.closing||closing.name!=='plist') throw Error('描述文件的 plist 元素未闭合');
      return inner;
    }
    if(tag.name==='dict') {
      const dict={};
      for(;;) {
        const peek=nextTag(true);
        if(!peek) throw Error('描述文件的 XML 结构不完整');
        if(peek.closing&&peek.name==='dict') { nextTag(); return dict; }
        if(peek.closing) throw Error('描述文件的 XML 结构不完整');
        if(peek.name!=='key') throw Error('描述文件的 dict 里出现了非 key 元素');
        nextTag(); // 消费 <key> 开始标签，再读它的文本内容。
        const key=readText('key').trim();
        dict[key]=parseValue();
      }
    }
    if(tag.name==='array') {
      const items=[];
      for(;;) {
        const peek=nextTag(true);
        if(!peek) throw Error('描述文件的 XML 结构不完整');
        if(peek.closing&&peek.name==='array') { nextTag(); return items; }
        if(peek.closing) throw Error('描述文件的 XML 结构不完整');
        items.push(parseValue());
      }
    }
    if(tag.selfClosing) {
      if(tag.name==='true') return true;
      if(tag.name==='false') return false;
      return null;
    }
    const value=readText(tag.name);
    if(tag.name==='integer') return Number.parseInt(value,10);
    if(tag.name==='real') return Number.parseFloat(value);
    if(tag.name==='data') return Buffer.from(value.replace(/\s+/g,''),'base64');
    return value;
  }
  return parseValue();

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
  // 按真正的 plist 结构判定（复核报告发现原实现数的是「PayloadType 键出现次数」，
  // 不是 PayloadContent 数组的元素个数——一个没有 PayloadType 的额外 dict 会被放过，
  // 与设计文档 §4.1 独立 plistlib 脚本的 assert len(payloads) == 1 口径打架）。
  let profile;
  try { profile=parsePlist(profileXml); }
  catch(error) { throw Error(`描述文件不是可解析的 plist：${error.message}`); }
  if(!profile||typeof profile!=='object'||Array.isArray(profile)) throw Error('描述文件的顶层不是字典');
  if(profile.PayloadType!=='Configuration') throw Error('描述文件的外层 PayloadType 必须是 Configuration');
  // 白名单而不是黑名单（docs/iphone-ca-profile-design.md §3.2）：描述文件里只允许两种
  // PayloadType——外层的 Configuration 与唯一一个 com.apple.security.root。
  // 黑名单（com.apple.vpn.* 之类）漏掉了 Apple 真实的无后缀类型名
  // （com.apple.security.pkcs12、com.apple.security.scep、com.apple.identityPreference…），
  // 而 pkcs12 能携带客户端身份与私钥——所以这里按解析出的 payload 类型逐个判定，
  // 出现任何白名单之外的类型一律拒绝。
  const ALLOWED_PAYLOAD_TYPES=new Set(['Configuration','com.apple.security.root']);
  const payloads=profile.PayloadContent;
  if(!Array.isArray(payloads)) throw Error('描述文件缺少 PayloadContent 数组');
  // 先逐个按类型判定（夹带的类型直接指名拒绝），再核对元素个数——
  // 两个口径都要拒：夹带异类型 payload 与夹带第二个同类型 payload。
  for(const payload of payloads) {
    if(!payload||typeof payload!=='object'||Array.isArray(payload)) throw Error('PayloadContent 里出现了非字典元素');
    const type=payload.PayloadType;
    if(typeof type!=='string'||!type.trim()) throw Error('PayloadContent 里的 payload 缺少 PayloadType');
    if(!ALLOWED_PAYLOAD_TYPES.has(type.trim())) {
      throw Error(`描述文件里出现了不该存在的 payload：${type}`);
    }
  }
  // 元素个数必须恰为 1（不是 1 个根 payload——夹带第二个同类型 payload 也要拒）。
  if(payloads.length!==1) {
    throw Error(`描述文件的 PayloadContent 必须只含一个 payload，实际含 ${payloads.length} 个`);
  }
  const rootPayload=payloads[0];
  if(rootPayload.PayloadType!=='com.apple.security.root') throw Error('描述文件必须且只能含一个根证书 payload');
  // §3.2 表格里的其余约束逐项核对：版本、UUID、标识、显示名、.cer 文件名、可移除。
  if(rootPayload.PayloadVersion!==1) throw Error('根证书 payload 的 PayloadVersion 必须是 1');
  if(typeof rootPayload.PayloadUUID!=='string'||!rootPayload.PayloadUUID.trim()) throw Error('根证书 payload 缺少 PayloadUUID');
  if(typeof rootPayload.PayloadIdentifier!=='string'||!rootPayload.PayloadIdentifier.trim()) throw Error('根证书 payload 缺少 PayloadIdentifier');
  if(typeof rootPayload.PayloadDisplayName!=='string'||!rootPayload.PayloadDisplayName.trim()) throw Error('根证书 payload 缺少 PayloadDisplayName');
  if(typeof rootPayload.PayloadCertificateFileName!=='string'||!rootPayload.PayloadCertificateFileName.trim().endsWith('.cer')) {
    throw Error('根证书 payload 的 PayloadCertificateFileName 必须指向 .cer 文件');
  }
  if(profile.PayloadVersion!==1) throw Error('描述文件的 PayloadVersion 必须是 1');
  if(typeof profile.PayloadUUID!=='string'||!profile.PayloadUUID.trim()) throw Error('描述文件缺少 PayloadUUID');
  if(typeof profile.PayloadIdentifier!=='string'||!profile.PayloadIdentifier.trim()) throw Error('描述文件缺少 PayloadIdentifier');
  if(typeof profile.PayloadDisplayName!=='string'||!profile.PayloadDisplayName.trim()) throw Error('描述文件缺少 PayloadDisplayName');
  // 允许用户移除：设成不可移除会让 §4.3 的卸载流程失效。
  if(profile.PayloadRemovalDisallowed===true) throw Error('描述文件不允许设置 PayloadRemovalDisallowed=true');
  const embedded=rootPayload.PayloadContent;
  if(!Buffer.isBuffer(embedded)||!embedded.length) throw Error('描述文件缺少 PayloadContent 数据');
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

