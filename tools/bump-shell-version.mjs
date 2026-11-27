// 推进 Web 壳的资源版本。
//
// 用法：node tools/bump-shell-version.mjs <新版本号>，例如 node tools/bump-shell-version.mjs 98
//
// 一次要改四处，缺一不可：
//   1. web/index.html 的 ?v=            —— 入口 HTML
//   2. web/sw.js 的 along-shell-v       —— Service Worker 的缓存名
//   3. ios/AlongHealth/Sources/AlongShellView.swift 的 build= —— 原生壳的缓存参数
//   4. web/*.mjs 里所有相对 import 说明符的 ?v= —— 模块的独立版本 URL
//
// 第 4 处最关键：模块说明符不带版本时，旧 HTML 过期而旧模块仍新鲜，
// 页面会拿到新入口配旧模块，直接白屏。带上版本后，同一次加载里的
// HTML 与模块必然同版本，不会混搭。
import {readFile, writeFile, readdir} from 'node:fs/promises';

const next=process.argv[2];
if(!/^\d+$/.test(next??'')) {
  console.error('用法：node tools/bump-shell-version.mjs <新版本号>');
  process.exit(1);
}
const version=String(Number(next));
const read=async path=>readFile(path,'utf8');
const write=async(path,text)=>{if(text!==await read(path).catch(()=>null))await writeFile(path,text);};

// 1) 模块说明符：所有相对 import 都带同一个版本参数。
for(const file of await readdir('web')) {
  if(!file.endsWith('.mjs'))continue;
  const path=`web/${file}`;
  const before=await read(path);
  const after=before
    .replace(/(from\s*'\.\/[^']+?)(\?v=\d+)?'/g,(_match,specifier)=>`${specifier}?v=${version}'`)
    .replace(/(import\(\s*'\.\/[^']+?)(\?v=\d+)?'\s*\)/g,(_match,specifier)=>`${specifier}?v=${version}')`);
  await write(path,after);
}

// 2) 入口 HTML。
{
  const path='web/index.html';
  const before=await read(path);
  await write(path,before.replace(/\?v=\d+/g,`?v=${version}`));
}

// 3) Service Worker 的缓存名。
{
  const path='web/sw.js';
  const before=await read(path);
  await write(path,before.replace(/along-shell-v\d+/g,`along-shell-v${version}`));
}

// 4) 原生壳的缓存参数。
{
  const path='ios/AlongHealth/Sources/AlongShellView.swift';
  const before=await read(path);
  await write(path,before.replace(/build=\d+/g,`build=${version}`));
}

await import('./build.mjs');
console.log(`Web 壳资源版本已推进到 v${version}（入口、Service Worker、原生壳与全部模块说明符），并重新生成 iOS 内置产物。`);
