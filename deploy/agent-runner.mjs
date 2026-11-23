// Along 云端 agent runner（docs/cloud-deploy-multi-user.md §3.5 M3，SD-3）。
//
// compose 内网 HTTP 服务，只服务 host 的 /super-agent/* DSH 分支（ALONG_DSH_RUNNER_URL 分流）。
// 每次调用以 `dsh --profile along-headless` 拉起一次性进程，经 stdin 提交任务。
// stdout 的最终 JSON 解析成与运行时无关的运行信封 {run}：runtime 固定 'dsh-superagent'——
// 不得照抄 Kimi 信封的 'kimi-code-swarm'，否则云端 run 会被错误标注（验收 #3）。
// 校验与生效不在这里：host 对 runner 返回一律先过 normalizeGoalRun，失败落终态 blocked。
//
// 红线（AGENTS.md §5、设计 §3.7）：dsh 的 stdout/stderr 与请求体就是运行内容，只解析、不写日志；
// runner-token 是服务端内部凭证，只留在 host↔agent 的 compose 内网请求头里，绝不下发。
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createHash, timingSafeEqual} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {AGENT_RUN_TIMEOUT_MS, CLOUD_RUN_NOT_FOUND, DSH_RUNTIME} from '../web/super-agent.mjs';
import {GOAL_OUTPUT_INSTRUCTIONS} from '../web/goal-agent-core.mjs';
import {REASSESSMENT_INSTRUCTIONS} from '../web/contextual-planning.mjs';

const PORT=Number(process.env.ALONG_RUNNER_PORT)||3088;
const HOST=process.env.ALONG_RUNNER_HOST||'0.0.0.0';
const DSH_BIN=process.env.ALONG_DSH_BIN||'dsh';
const DSH_PROFILE='along-headless';
const DSH_PATH=[dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':');
// DSH rc.5 的自定义 Cordis profile。从空 bundle 列表开始，只装载一次性模型运行所需的服务。
// agent-loop 依赖 tools 服务和原生执行器。没有注册任何工具的插件，工具表始终为空。
const DSH_PROFILE_MANIFEST=JSON.stringify({
  name:`dsh-profile-${DSH_PROFILE}`,
  private:true,
  dsh:{profile:{bundles:[]}},
});
const DSH_PROFILE_PATCH=JSON.stringify([{insert:[
  {id:'timer',name:'@deepseek-ai/cordis-plugin-timer'},
  {id:'llm',name:'@deepseek-ai/dsh-llm'},
  {id:'llm-deepseek',name:'@deepseek-ai/dsh-llm-deepseek-api-key',config:{apiKeyEnv:'DEEPSEEK_API_KEY'}},
  {id:'session',name:'@deepseek-ai/dsh-session'},
  {id:'session-projection',name:'@deepseek-ai/dsh-session-projection'},
  {id:'system-prompt',name:'@deepseek-ai/dsh-system-prompt',
    config:{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:'You are the Along cloud planning agent.'}},
  {id:'tools',name:'@deepseek-ai/dsh-tools'},
  {id:'tool-executor-native',name:'@deepseek-ai/dsh-tool-executor-native'},
  {id:'agent',name:'@deepseek-ai/dsh-agent'},
  {id:'agent-loop',name:'@deepseek-ai/dsh-agent-loop',config:{agents:[]}},
  {id:'agent-default-model',name:'@deepseek-ai/dsh-agent-default-model',
    config:{provider:'deepseek-official',model:'deepseek-flash'}},
  {id:'headless-runner',name:'@deepseek-ai/dsh-headless'},
]}]);
// 一次运行最多等这么久：与前端兜底同一个值（web/super-agent.mjs AGENT_RUN_TIMEOUT_MS）。
const RUN_TIMEOUT_MS=AGENT_RUN_TIMEOUT_MS;
const MAX_BODY=64*1024;
const MAX_STDOUT=1024*1024;
const CACHE_LIMIT=200;
const ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const USER_PATTERN=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MANDATE='只规划目标与动态任务；不执行外部写操作。';

// compose secrets 是 bind mount，容器内权限=宿主权限，Runbook 要求 0600。
// 权限过宽（组/其他可读）等同配置错误：拒绝启动，且报错只提路径不回显文件内容（G-6）。
function readSecretFile(file,label) {
  let stat;
  try { stat=statSync(file); }
  catch { throw Error(`${label}文件无法读取：${file}`); }
  if (stat.mode&0o077) throw Error(`${label}文件权限过宽（须 0600，拒绝启动）：${file}`);
  return readFileSync(file,'utf8').trim();
}

// runner-token 只从 secret 文件读（compose secrets，0600）：缺失直接起不来，不静默降级。
const tokenFile=process.env.ALONG_RUNNER_TOKEN_FILE;
if (!tokenFile) throw Error('云端 agent runner 需要 runner-token：设置 ALONG_RUNNER_TOKEN_FILE 后重启');
const runnerToken=readSecretFile(tokenFile,'runner-token ');
if (!runnerToken) throw Error('runner-token 文件为空');

function readModelApiKey() {
  const secretFile=process.env.ALONG_MODEL_API_KEY_FILE;
  if (!secretFile) throw Error('云端 agent runner 需要模型密钥，请设置 ALONG_MODEL_API_KEY_FILE');
  const key=readSecretFile(secretFile,'模型密钥');
  if (!/^[^\s\0]+$/.test(key)) throw Error('模型密钥文件须包含单行非空 DeepSeek API key');
  return key;
}
const modelApiKey=readModelApiKey();
const encodedSecrets=[modelApiKey,runnerToken].map(secret=>JSON.stringify(secret).slice(1,-1));

// 两个 secret 已读入内存（此后 runner 不再读 secret 文件），在 listen 之前把整个 runner 进程
// 降权到 node 用户（node 官方镜像自带 uid 1000 的 node 用户）：先 setgid 后 setuid——
// setuid 之后没有权限再改组。仅 root 时执行，开发机/测试非 root 直接跳过；降权失败拒绝启动。
// 降权后 runner 与它拉起的每个 dsh 子进程都读不到 root 0600 的 /run/secrets/*（G-6）。
function dropPrivileges() {
  if (typeof process.getuid!=='function'||process.getuid()!==0) return;
  try {
    process.setgid('node');
    process.setuid('node');
  } catch (error) {
    throw Error(`runner 降权失败（容器内需要 node 用户），拒绝启动：${error?.message??error}`);
  }
}
dropPrivileges();
function tokenOk(value) {
  if (typeof value!=='string'||!value) return false;
  // 比较前先哈希：消除长度差，可用 timingSafeEqual。
  return timingSafeEqual(createHash('sha256').update(runnerToken).digest(),createHash('sha256').update(value).digest());
}

// dsh 的最终答案是一段文本里嵌着 JSON：先试 ```json 围栏，再试整段，最后试首尾大括号。
// 与 Kimi 运行时的提取策略一致（host/kimi-code-agent.mjs 的 jsonFromText）。
function jsonFromText(text) {
  const source=String(text??'').trim();
  const fenced=source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates=[fenced,source,source.slice(source.indexOf('{'),source.lastIndexOf('}')+1)].filter(Boolean);
  for (const candidate of candidates) { try { return JSON.parse(candidate); } catch { /* 换下一种表示再试 */ } }
  return null;
}

// 云端 dsh 是单进程 headless，没有 Kimi 那样的 Swarm 编排语言；输出 JSON 形状与 Kimi 共用
// 同一份契约常量（GOAL_OUTPUT_INSTRUCTIONS / REASSESSMENT_INSTRUCTIONS），两条运行时同契约。
function goalPrompt(input) {
  return `You are the Along cloud planning agent. This is planning only. Do not edit files, run shell commands, browse private data, publish, pay, delete, or perform any external action. Only use the information below.

Along input:
${JSON.stringify({goal:input.goal,snapshot:input.snapshot,message:input.message,history:input.history})}

Return one final JSON object only, without markdown.
${input.snapshot?.planning?REASSESSMENT_INSTRUCTIONS:GOAL_OUTPUT_INSTRUCTIONS}`;
}
function taskPrompt(input) {
  return `You are the Along cloud planning agent. Planning only: do not edit files, run shell commands, publish, pay, delete, or perform external actions.

Along task:
${JSON.stringify(input)}

Return one final JSON object only: {"summary":"Chinese delivery summary","next":"concrete next action"}.`;
}

// 运行信封形状以 Kimi 运行时的 run 为准（须通过 web/super-agent.mjs 的
// safeGoalSuperAgentRun / safeSuperAgentRun 白名单）。
const runPhase={
  working:{statusLabel:'DSH 正在编排',progress:12,eval:null},
  done:{statusLabel:'DSH 已完成',progress:100,eval:{decision:'accept'}},
  blocked:{statusLabel:'输出需要重试',progress:12,eval:{decision:'blocked'}},
};
function goalRunEnvelope(request,outcome) {
  const now=Date.now();
  const {status,result=null,error}=outcome;
  return {
    version:1,kind:'goal',actual:true,runtime:DSH_RUNTIME,requestId:request.requestId,
    source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'DSH Headless'},
    status,...runPhase[status],ticket:null,mandate:MANDATE,
    events:[{at:now,text:runPhase[status].statusLabel}],
    createdAt:request.createdAt,updatedAt:now,
    input:{goal:request.input.goal,message:request.input.message,
      snapshot:{planning:request.input.snapshot?.planning??null}},
    assignments:[],agents:[],result,...(error?{error}:{}),
  };
}
function taskRunEnvelope(request,outcome) {
  const now=Date.now();
  const {status,result=null,error}=outcome;
  const summary=typeof result?.summary==='string'?result.summary.trim().slice(0,300):'';
  return {
    version:2,actual:true,runtime:DSH_RUNTIME,requestId:request.requestId,
    source:{kind:'along',label:'Along 动态任务'},trigger:{kind:'task',label:'DSH Headless'},
    status,...runPhase[status],ticket:null,mandate:MANDATE,
    events:[{at:now,text:runPhase[status].statusLabel}],
    createdAt:request.createdAt,updatedAt:now,
    task:request.input.task,
    assignments:status==='done'?[{id:`dsh-${request.requestId}`,name:'DSH Headless',role:'Subagent',status:'done',
      objective:'规划该动态任务。',work:'已完成规划',progress:100,report:{summary:summary||'结果已返回'}}]:[],
    result,...(error?{error}:{}),
  };
}

// 每次使用独立 home 和工作目录。Compose 的 /tmp 由 tmpfs 承载，运行结束即清理。
async function runDsh(prompt) {
  try {
    const runDir=await mkdtemp(join(tmpdir(),'along-dsh-'));
    try {
      const cwd=join(runDir,'workspace');
      const home=join(runDir,'home');
      const dshHome=join(home,'.dsh');
      const profileDir=join(dshHome,'profiles',DSH_PROFILE);
      await mkdir(cwd,{mode:0o700});
      await mkdir(profileDir,{recursive:true,mode:0o700});
      await writeFile(join(profileDir,'package.json'),DSH_PROFILE_MANIFEST,{mode:0o600});
      await writeFile(join(profileDir,'cordis.patch.yml'),DSH_PROFILE_PATCH,{mode:0o600});
      return await runDshProcess(prompt,cwd,{
        PATH:DSH_PATH, HOME:home, DSH_HOME:dshHome, TMPDIR:runDir, DEEPSEEK_API_KEY:modelApiKey,
      });
    } finally {
      await rm(runDir,{recursive:true,force:true});
    }
  } catch {
    return {status:'blocked',error:'DSH 无法使用隔离工作目录'};
  }
}

// stdout/stderr 只在这里处理，避免把用户数据或供应商诊断写入日志或运行错误。
function runDshProcess(prompt,cwd,env) {
  return new Promise(resolve=>{
    let size=0,timedOut=false,overflow=false,spawnFailed=false;
    const chunks=[];
    const child=spawn(DSH_BIN,['--profile',DSH_PROFILE],{cwd,env,stdio:['pipe','pipe','pipe']});
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},RUN_TIMEOUT_MS);
    child.stdin.on('error',()=>{}); // 提前退出由 close 的退出码处理。
    child.stdin.end(prompt);
    child.stdout.on('data',data=>{
      if (overflow) return;
      size+=data.length;
      if (size>MAX_STDOUT) {
        overflow=true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(data);
    });
    child.stderr.resume();
    child.on('error',()=>{spawnFailed=true;});
    child.on('close',code=>{
      clearTimeout(timer);
      if (spawnFailed) return resolve({status:'blocked',error:'DSH 无法启动'});
      if (timedOut) return resolve({status:'blocked',error:'DSH 长时间没有返回结果，已停止等待'});
      if (overflow) return resolve({status:'blocked',error:'DSH 返回了超过大小限制的输出'});
      const stdout=Buffer.concat(chunks,size).toString('utf8');
      if (code!==0||!stdout.trim()) return resolve({status:'blocked',error:`DSH 没有返回结果${code?`（退出码 ${code}）`:''}`});
      const parsed=jsonFromText(stdout);
      if (!parsed||typeof parsed!=='object'||Array.isArray(parsed)) return resolve({status:'blocked',error:'DSH 已完成，但没有返回可用结果'});
      try {
        const serialized=JSON.stringify(parsed);
        if (!encodedSecrets.some(secret=>serialized.includes(secret))) return resolve({status:'done',result:parsed});
      } catch { /* 嵌套过深等不可序列化结果也落终态。 */ }
      resolve({status:'blocked',error:'DSH 返回了不可交付的结果'});
    });
  });
}

// 并发硬上限（G-1 runner 侧）：2 用户各 2 并发的资源上界，与 compose 的 mem/pids 上限配合。
// 超限的 POST /run 直接 429，不 spawn dsh；同键幂等重提交优先于上限，不受其影响。
const MAX_RUNS_PER_USER=2;
const MAX_RUNS_TOTAL=4;

// 在途记录可立即查询，不受已完成记录的 LRU 淘汰影响。同键 POST 复用原记录。
const cache=new Map();
const inflight=new Map();
const inflightPerUser=new Map();
const cacheKey=(userId,requestId)=>`${userId}:${requestId}`;
function cacheGet(key) {
  const run=cache.get(key);
  if (run===undefined) return null;
  cache.delete(key);cache.set(key,run);
  return run;
}
function cacheSet(key,run) {
  cache.delete(key);cache.set(key,run);
  if (cache.size>CACHE_LIMIT) cache.delete(cache.keys().next().value);
}
function findRun(key) {
  return inflight.get(key)??cacheGet(key);
}
function execute(kind,request) {
  const key=cacheKey(request.userId,request.requestId);
  const existing=findRun(key);
  if (existing) return existing;
  if (inflight.size>=MAX_RUNS_TOTAL||(inflightPerUser.get(request.userId)??0)>=MAX_RUNS_PER_USER) return null;
  const envelope=kind==='goal'?goalRunEnvelope:taskRunEnvelope;
  const pending=envelope(request,{status:'working'});
  inflight.set(key,pending);
  inflightPerUser.set(request.userId,(inflightPerUser.get(request.userId)??0)+1);
  void Promise.resolve()
    .then(()=>runDsh(kind==='goal'?goalPrompt(request.input):taskPrompt(request.input)))
    .catch(()=>({status:'blocked',error:'DSH 无法完成规划'}))
    .then(outcome=>cacheSet(key,envelope(request,outcome)))
    .finally(()=>{
      inflight.delete(key);
      const remaining=(inflightPerUser.get(request.userId)??1)-1;
      if (remaining>0) inflightPerUser.set(request.userId,remaining);
      else inflightPerUser.delete(request.userId);
    });
  return pending;
}

function respond(res,status,data) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(data)); }
async function readBody(req) {
  const chunks=[];
  let size=0;
  for await (const chunk of req.iterator({destroyOnReturn:false})) {
    size+=chunk.length;
    if (size>MAX_BODY) throw Error('请求体超过大小限制');
    chunks.push(chunk);
  }
  return size?JSON.parse(Buffer.concat(chunks,size).toString('utf8')):null;
}
const server=createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,'http://agent').pathname;
    // /health 供 compose healthcheck 匿名探测（§3.1）；其余端点一律先验 runner-token（§3.3）。
    if (req.method==='GET'&&path==='/health') return respond(res,200,{service:'along-agent-runner',ready:true,dsh:DSH_BIN});
    if (!tokenOk(req.headers['runner-token'])) return respond(res,401,{error:'runner-token 无效'});
    if (req.method==='POST'&&path==='/run') {
      const body=await readBody(req);
      if (typeof body?.userId!=='string'||!USER_PATTERN.test(body.userId)) throw Error('userId 无效');
      if (typeof body?.requestId!=='string'||!ID_PATTERN.test(body.requestId)) throw Error('requestId 无效');
      if (!['goal','task'].includes(body?.kind)) throw Error('kind 无效');
      if (!body?.input||typeof body.input!=='object'||Array.isArray(body.input)) throw Error('input 无效');
      const run=execute(body.kind,{userId:body.userId,requestId:body.requestId,input:body.input,createdAt:Date.now()});
      // 超限不 spawn：429 原文案由 M1 的 runnerCall 透传到客户端（§3.1-(7)）。
      if (!run) return respond(res,429,{error:'模型运行并发已达上限，请稍后再试'});
      return respond(res,200,{run});
    }
    const match=req.method==='GET'&&path.match(/^\/run\/([^/]+)$/);
    if (match) {
      const requestId=decodeURIComponent(match[1]);
      const userId=String(req.headers['x-along-user']??'');
      if (!ID_PATTERN.test(requestId)||!USER_PATTERN.test(userId)) throw Error('运行查询无效');
      const run=findRun(cacheKey(userId,requestId));
      if (!run) return respond(res,404,{error:CLOUD_RUN_NOT_FOUND});
      return respond(res,200,{run});
    }
    return respond(res,404,{error:'未找到接口'});
  } catch(error) { respond(res,400,{error:error?.message??String(error)}); }
});
server.listen(PORT,HOST,()=>{
  // 启动横幅只打地址与形态，不打凭证（§3.7）。
  console.log(`Along agent runner: http://${HOST}:${PORT} (dsh: ${DSH_BIN})`);
});
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
