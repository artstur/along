import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, mkdtemp, mkdir, copyFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo=join(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFile(join(repo,path),'utf8');
const webFiles=async()=>(await readdir(join(repo,'web'))).filter(file=>file.endsWith('.mjs'));
const importSpecifiers=source=>[...source.matchAll(/(?:from|import)\s*'\.\/[^']+'/g)].map(match=>match[0].replace(/^.*'(\.\/[^']+)'$/,'$1'));
const versionOf={
  async index(){ return /app\.mjs\?v=(\d+)/.exec(await read('web/index.html'))?.[1]??null; },
  async serviceWorker(){ return /along-shell-v(\d+)/.exec(await read('web/sw.js'))?.[1]??null; },
  async native(){ return /index\.html\?build=(\d+)/.exec(await read('ios/AlongHealth/Sources/AlongShellView.swift'))?.[1]??null; },
};

test('the Web entry, the service worker and the native shell share one resource version',async()=>{
  const [index,serviceWorker,native]=await Promise.all([versionOf.index(),versionOf.serviceWorker(),versionOf.native()]);
  assert.ok(index,'web/index.html 里要有 app.mjs?v= 版本号');
  assert.equal(serviceWorker,index,'Service Worker 的缓存名版本要和入口一致');
  assert.equal(native,index,'原生壳的 build= 版本要和入口一致');
});

test('every module import carries the resource version so old and new modules never mix',async()=>{
  const version=await versionOf.index();
  for(const file of await webFiles()) {
    const source=await read(`web/${file}`);
    for(const specifier of importSpecifiers(source)) {
      assert.match(specifier,/\?v=\d+$/,`web/${file} 的模块说明符 ${specifier} 要带 ?v= 版本参数`);
      assert.equal(specifier.split('?v=')[1],version,`web/${file} 的模块说明符 ${specifier} 要用当前资源版本 v${version}`);
    }
  }
});

test('every imported module is precached by the service worker',async()=>{
  const source=await read('web/sw.js');
  const cached=new Set(JSON.parse(source.match(/const FILES=(\[[^\]]*\])/)[1].replaceAll("'",'"')));
  for(const file of await webFiles()) {
    for(const specifier of importSpecifiers(await read(`web/${file}`))) {
      const target=specifier.split('?')[0].replace(/^\.\//,'');
      assert.ok(cached.has(`./${target}`),`Service Worker 的预缓存清单里要有 ${target}`);
    }
  }
});

test('bumping the shell version moves the entry, the worker, the native shell and every module together',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'along-shell-version-'));
  try {
    await mkdir(join(dir,'web'));
    await mkdir(join(dir,'tools'));
    await mkdir(join(dir,'ios/AlongHealth/Sources'),{recursive:true});
    for(const file of await readdir(join(repo,'web')))await copyFile(join(repo,'web',file),join(dir,'web',file));
    for(const file of ['build.mjs','bump-shell-version.mjs'])await copyFile(join(repo,'tools',file),join(dir,'tools',file));
    await copyFile(join(repo,'ios/AlongHealth/Sources/AlongShellView.swift'),join(dir,'ios/AlongHealth/Sources/AlongShellView.swift'));
    const before=await versionOf.index();
    const next=String(Number(before)+1);
    execFileSync('node',['tools/bump-shell-version.mjs',next],{cwd:dir,stdio:'ignore'});
    const readIn=async path=>readFile(join(dir,path),'utf8');
    assert.match(await readIn('web/index.html'),new RegExp(`app\\.mjs\\?v=${next}\\b`));
    assert.match(await readIn('web/sw.js'),new RegExp(`along-shell-v${next}\\b`));
    assert.match(await readIn('ios/AlongHealth/Sources/AlongShellView.swift'),new RegExp(`build=${next}\\b`));
    for(const file of (await readdir(join(dir,'web'))).filter(file=>file.endsWith('.mjs'))) {
      for(const specifier of importSpecifiers(await readIn(`web/${file}`))) {
        assert.equal(specifier.split('?v=')[1],next,`${file} 的模块说明符 ${specifier} 要跟着一起推进`);
      }
    }
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
