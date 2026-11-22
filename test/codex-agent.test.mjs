import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runTaskCodex} from '../host/codex-agent.mjs';
import {HostError, upstream} from '../host/host-error.mjs';

// M4 credential-hygiene 验收 3（docs/cloud-security-hardening.md §3.4-(3)，G-11）：codex env 与错误卫生。
// CODEX_BIN 假脚本注入——
// · 子进程 env 剔除全部 ALONG_*（G-11 点名的泄漏路径：ALONG_KIMI_CODE_TOKEN 经全量继承进 codex）；
// · 非 ALONG_ 控制变量与既有 env 原样透传（白名单会弄坏 codex 认证/代理/证书 env，评审拍板用剔除而非白名单）；
// · 假脚本 exit 1 + stderr 样文本 → 客户端文案恰为「Along 暂时不可用」，stderr 内容不回传、不进日志，
//   服务端只记一行只含退出码的告警。

const STDERR_CANARY='along-stderr-leak-canary-do-not-log';
const ALONG_TOKEN_CANARY='along-kimi-token-leak-canary-value';
const PROXY_CANARY='http://along-proxy-canary:0';
const CONTROL_VALUE='codex-hygiene-control-value';

// 假 codex：把子进程看到的 env 原样落盘后往 stderr 写样文本，再按 CODEX_TEST_EXIT 退出（默认 1）。
// 落盘路径经 CODEX_TEST_ENV_OUT 传入——dump 能写出来，本身就证明非 ALONG_ 控制变量透传了。
function writeFakeCodex(directory) {
  const script=join(directory,'codex-fake.mjs');
  writeFileSync(script,[
    '#!/usr/bin/env node',
    "import {writeFileSync} from 'node:fs';",
    'writeFileSync(process.env.CODEX_TEST_ENV_OUT, JSON.stringify(process.env));',
    `console.error(process.env.CODEX_TEST_STDERR ?? ${JSON.stringify(STDERR_CANARY)});`,
    "process.exit(Number(process.env.CODEX_TEST_EXIT ?? '1'));",
  ].join('\n'));
  chmodSync(script,0o700);
  return script;
}

const ENV_KEYS=['CODEX_BIN','CODEX_TEST_ENV_OUT','CODEX_TEST_EXIT','CODEX_TEST_STDERR','ALONG_KIMI_CODE_TOKEN','ALONG_TEST_PROXY_STYLE_VAR','CODEX_TEST_CTRL'];

async function runFakeCodex({exit='1'}={}) {
  const directory=mkdtempSync(join(tmpdir(),'codex-hygiene-'));
  const dump=join(directory,'child-env.json');
  const saved=new Map(ENV_KEYS.map(key=>[key,process.env[key]]));
  const warns=[];
  const originalWarn=console.warn;
  console.warn=(...parts)=>warns.push(parts.map(String).join(' '));
  process.env.CODEX_BIN=writeFakeCodex(directory);
  process.env.CODEX_TEST_ENV_OUT=dump;
  process.env.CODEX_TEST_EXIT=exit;
  delete process.env.CODEX_TEST_STDERR;
  process.env.ALONG_KIMI_CODE_TOKEN=ALONG_TOKEN_CANARY;
  process.env.ALONG_TEST_PROXY_STYLE_VAR=PROXY_CANARY;
  process.env.CODEX_TEST_CTRL=CONTROL_VALUE;
  try {
    const outcome=await runTaskCodex('生成一段日程建议').then(value=>({ok:true,value}),error=>({ok:false,error}));
    return {outcome,warns,childEnv:JSON.parse(readFileSync(dump,'utf8'))};
  } finally {
    console.warn=originalWarn;
    for (const [key,value] of saved) { if (value===undefined) delete process.env[key]; else process.env[key]=value; }
    rmSync(directory,{recursive:true,force:true});
  }
}

test('codex 子进程 env：任何 ALONG_* 键都不进子进程，非 ALONG_ 控制变量与既有 env 原样透传',async()=>{
  const {childEnv}=await runFakeCodex();
  assert.equal(Object.keys(childEnv).some(key=>key.startsWith('ALONG_')),false,'ALONG_* 命名空间一个键都不许带进 codex 子进程');
  assert.ok(!JSON.stringify(childEnv).includes(ALONG_TOKEN_CANARY),'凭证值不得以任何键值形态出现在子进程 env 里');
  assert.equal(childEnv.CODEX_TEST_CTRL,CONTROL_VALUE,'非 ALONG_ 控制变量原样透传');
  assert.equal(childEnv.PATH,process.env.PATH,'既有 env（PATH）原样继承，codex 认证/代理/证书 env 不受影响');
});

test('codex 非零退出：客户端文案恰为「Along 暂时不可用」，stderr 样文本不回传、不进日志',async()=>{
  const {outcome,warns}=await runFakeCodex({exit:'1'});
  assert.equal(outcome.ok,false,'exit 1 必须拒绝');
  assert.equal(outcome.error.message,'Along 暂时不可用','文案固定：不含退出码之外的 stderr 样文本');
  // agent-host 用 upstream() 包住 codex 调用：message 原样变成客户端看到的 HostError 文案（host/host-error.mjs:7-9）。
  await assert.rejects(()=>upstream(()=>Promise.reject(outcome.error)),
    error=>error instanceof HostError&&error.status===502&&error.message==='Along 暂时不可用',
    '经 upstream 后客户端收到的 message 仍是固定文案');
  assert.equal(warns.length,1,'服务端只记一行告警');
  assert.ok(!warns[0].includes(STDERR_CANARY),'stderr 样文本不得进服务端日志');
  assert.match(warns[0],/1/,'告警带退出码');
});

test('codex 退出告警里的数字就是退出码（137），且不含 stderr 内容',async()=>{
  const {outcome,warns}=await runFakeCodex({exit:'137'});
  assert.equal(outcome.error.message,'Along 暂时不可用');
  assert.equal(warns.length,1,'服务端只记一行告警');
  assert.match(warns[0],/137/,'告警里的数字是退出码本身');
  assert.ok(!warns[0].includes(STDERR_CANARY),'stderr 样文本不得进服务端日志');
});
