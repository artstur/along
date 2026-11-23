// CA 描述文件制作与核验命令行工具（docs/iphone-ca-profile-design.md §3.2/§4.1）。
//
// 用法：
//   node tools/ca-profile.mjs profile --root <root.crt> --environment <env> [--out <file>]
//       从公开根证书制作只含该根的 .mobileconfig，并打印核验摘要。
//   node tools/ca-profile.mjs verify --profile <file.mobileconfig> --root <root.crt>
//       核验描述文件结构与其嵌入的根是否与批准的根一致。
//
// 边界：只处理公开材料。根私钥的生成、保管与叶证书签发属于离线 CA 保管机，
// 不在本工具内；本工具也不安装描述文件、不接触手机。

import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {buildRootProfile,verifyRootProfile,profileDigest,rootDerFromPem} from '../host/ca-profile.mjs';

function parseArgs(argv) {
  const args={};
  for(let index=0;index<argv.length;index++) {
    const token=argv[index];
    if(!token.startsWith('--')) throw Error(`无法识别的参数 ${token}`);
    const name=token.slice(2);
    const value=argv[index+1];
    if(value===undefined||value.startsWith('--')) throw Error(`参数 --${name} 缺少取值`);
    args[name]=value;
    index++;
  }
  return args;
}

function loadRoot(file) {
  if(!file) throw Error('需要 --root <root.crt>');
  if(!existsSync(file)) throw Error(`找不到根证书文件 ${file}`);
  const raw=readFileSync(file);
  return raw.includes('-----BEGIN CERTIFICATE-----')?rootDerFromPem(raw.toString('utf8')):raw;
}

function commandProfile(args) {
  const rootDer=loadRoot(args.root);
  const environment=args.environment||'test';
  const rootId=args['root-id']||createHash('sha256').update(rootDer).digest('hex').slice(0,12).toLowerCase();
  const profile=buildRootProfile({rootDer,environment,rootId});
  const verified=verifyRootProfile({profileXml:profile.xml,rootDer});
  const out=args.out;
  if(out) writeFileSync(out,profile.xml,{mode:0o644});
  console.log(`PayloadIdentifier: ${profile.identifier}`);
  console.log(`PayloadDisplayName: ${profile.displayName}`);
  console.log(`根 DER SHA-256: ${verified.rootDER}`);
  console.log(`根 SPKI SHA-256: ${verified.rootSPKI}`);
  console.log(`根序列号: ${verified.serialNumber}`);
  console.log(`根有效期: ${verified.notBefore} — ${verified.notAfter}`);
  console.log(`描述文件 SHA-256: ${profileDigest(profile.xml)}`);
  if(out) console.log(`已写出: ${resolve(out)}`);
}

function commandVerify(args) {
  if(!args.profile) throw Error('需要 --profile <file.mobileconfig>');
  if(!existsSync(args.profile)) throw Error(`找不到描述文件 ${args.profile}`);
  const rootDer=loadRoot(args.root);
  const profileXml=readFileSync(args.profile,'utf8');
  const verified=verifyRootProfile({profileXml,rootDer});
  console.log('结构合规，嵌入根与批准根一致');
  console.log(`根 DER SHA-256: ${verified.rootDER}`);
  console.log(`根 SPKI SHA-256: ${verified.rootSPKI}`);
  console.log(`描述文件 SHA-256: ${profileDigest(profileXml)}`);
}

const [command,...rest]=process.argv.slice(2);
const args=parseArgs(rest);
try {
  if(command==='profile') commandProfile(args);
  else if(command==='verify') commandVerify(args);
  else throw Error('用法：node tools/ca-profile.mjs <profile|verify> [--root root.crt] [--environment env] [--out file]');
} catch(error) {
  console.error(`Along CA 描述文件工具失败：${error.message}`);
  process.exit(1);
}

