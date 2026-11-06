import {createServer} from 'node:https';
import {randomBytes, randomInt, createHash, timingSafeEqual} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir, networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync} from 'node:fs';
import {routeHealthChange, requestedTargetFromMessage, validateGoalReply, validateTaskReply} from '../web/goal-agent-core.mjs';
import {safeAdaptiveLayout} from '../web/adaptive-ui.mjs';
import {runTaskCodex} from './codex-agent.mjs';
import {KimiCodeAgent} from './kimi-code-agent.mjs';
import {DSH_RUNTIME, KIMI_RUNTIME, safeAgentRuntime} from '../web/super-agent.mjs';

const dir = join(homedir(), '.along', 'agent-host');
mkdirSync(dir, {recursive:true, mode:0o700});
const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
if (!existsSync(key) || !existsSync(cert)) {
  execFileSync('openssl', ['req','-x509','-newkey','rsa:3072','-nodes','-keyout',key,'-out',cert,'-days','30','-subj','/CN=Along Local Agent']);
  chmodSync(key,0o600);
}
const certDER = execFileSync('openssl',['x509','-in',cert,'-outform','DER']);
const fingerprint = createHash('sha256').update(certDER).digest('hex').toUpperCase();
const code = String(randomInt(10000000, 99999999));
const codeExpiry = Date.now() + 15*60_000;
let pairFailures = 0;
const pairingPath=join(dir,'pairing.json');
let tokenHash = null;
try {
  const saved=JSON.parse(readFileSync(pairingPath,'utf8'));
  if (typeof saved.hash==='string' && /^[a-f0-9]{64}$/.test(saved.hash)) tokenHash=Buffer.from(saved.hash,'hex');
} catch (error) { if (error.code!=='ENOENT') throw error; }
let busy = false;
const port = Number(process.env.ALONG_AGENT_PORT) || 4176;
const lanHost = process.env.ALONG_AGENT_HOST || networkInterfaces().en0?.find(item=>item.family==='IPv4'&&!item.internal)?.address || '127.0.0.1';
const superAgentURL = (process.env.ALONG_SUPERAGENT_URL || 'http://127.0.0.1:3082').replace(/\/$/,'');
const kimiAgent = new KimiCodeAgent({workspace:process.env.ALONG_KIMI_WORKSPACE||process.cwd()});

function respond(res,status,data) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(data)); }
async function body(req) {
  let text='';
  for await (const chunk of req) { text+=chunk; if (text.length>32_000) throw Error('请求过大'); }
  return JSON.parse(text);
}
function authorized(req) {
  const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  return !!(token && tokenHash && timingSafeEqual(createHash('sha256').update(token).digest(),tokenHash));
}
async function superAgentCall(path,{method='POST',value}={}) {
  let response;
  try {
    response=await fetch(`${superAgentURL}${path}`,{method,headers:{'x-along-bridge':'1',...(value===undefined?{}:{'content-type':'application/json'})},
      ...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(15_000)});
  } catch(error) { throw Error(`Along 服务暂不可用：${error.message}`); }
  let result;
  try { result=await response.json(); } catch { throw Error(`Along 返回了无效响应（${response.status}）`); }
  if (!response.ok) throw Error(result?.error || `Along 请求失败（${response.status}）`);
  return result;
}
async function superAgentReady() {
  let response;
  try {
    response=await fetch(`${superAgentURL}/along-source/api/goals/along-status-probe`,{
      method:'GET',headers:{'x-along-bridge':'1'},signal:AbortSignal.timeout(5_000)
    });
  } catch(error) { throw Error(`DSH Super Agent 未运行：${error.message}`); }
  if (response.status!==404 && !response.ok) throw Error(`DSH Along Source 未就绪（${response.status}）`);
  return true;
}
function cleanGoal(value) {
  const domain=value?.domain;
  if (!['health','finance','custom'].includes(domain)) throw Error('目标类型无效');
  if (domain==='custom') {
    const title=String(value?.title??'').trim();
    if (!title||title.length>80) throw Error('目标名称无效');
    return {domain,target:null,title};
  }
  const limit=domain==='health'?10080:10000000;
  const target=value?.target;
  if (!Number.isInteger(target)||target<1||target>limit) throw Error('目标数值无效');
  const title=String(value?.title??'').trim();
  if (!title||title.length>80) throw Error('目标名称无效');
  return {domain,target,title};
}
function cleanSnapshot(value,domain) {
  if (domain==='custom') return {source:'暂无连接'};
  if (domain==='finance') return {saved:Number.isInteger(value?.saved) && value.saved>=0 ? Math.min(value.saved,10000000) : null, source:'演示数据'};
  const selected=Array.isArray(value?.selectedTypes)?value.selectedTypes.filter(type=>['workout','steps','weight','sleep'].includes(type)):[];
  return {workoutMinutes:selected.includes('workout') && Number.isInteger(value?.workoutMinutes) ? Math.min(Math.max(value.workoutMinutes,0),10080):null, selectedTypes:selected, source:'Apple Health 最小摘要'};
}
async function runExclusive(operation) {
  if (busy) throw Error('Along 正在处理上一条请求，请稍后再试');
  busy=true;
  try { return await operation(); }
  finally { busy=false; }
}
function requestId(value) {
  const id=String(value??'');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id)) throw Error('Along requestId 无效');
  return id;
}
function requestedRuntime(value) {
  if (value!==undefined && ![DSH_RUNTIME,KIMI_RUNTIME].includes(value)) throw Error('Super Agent 运行时无效');
  return safeAgentRuntime(value);
}
function normalizeGoalRun(run) {
  if (!run?.result) return run;
  const domain=run.input?.goal?.domain;
  if (!['health','finance','custom'].includes(domain)) throw Error('Along 返回的目标类型无效');
  const output=validateGoalReply(run.result,domain);
  const layout=run.result.layout==null?null:safeAdaptiveLayout(run.result.layout,domain);
  if (run.result.layout!=null && !layout) throw Error('Along 返回的目标空间格式不正确');
  const requested=requestedTargetFromMessage(String(run.input?.message??''),domain);
  if (requested!=null && output.proposal?.target!==requested) throw Error(`Along 目标数值与用户指定的 ${requested} 不一致`);
  return {...run,result:{...output,layout}};
}
const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},async(req,res)=>{
  try {
    const path=new URL(req.url,'https://along.local').pathname;
    if (req.method==='GET' && path==='/health') return respond(res,200,{service:'along-agent-host',ready:true});
    if (req.method==='POST' && path==='/pair') {
      const input=await body(req);
      if (Date.now()>codeExpiry || pairFailures>=5 || input?.code!==code) {pairFailures++; return respond(res,403,{error:'配对码无效或已过期'});}
      const token=randomBytes(32).toString('hex');
      tokenHash=createHash('sha256').update(token).digest();
      writeFileSync(pairingPath,JSON.stringify({hash:tokenHash.toString('hex')}),{mode:0o600});
      pairFailures=5;
      return respond(res,200,{token});
    }
    if (!authorized(req)) return respond(res,401,{error:'请先配对这台 Mac'});
    if (req.method==='POST' && path==='/connection/status') {
      const input=await body(req),runtime=requestedRuntime(input?.runtime);
      if (runtime===KIMI_RUNTIME) {
        const kimi=await kimiAgent.ready();
        console.log(`连接检查通过：iPhone → Along Host → Kimi Code Swarm (${new Date().toISOString()})`);
        return respond(res,200,{along:true,runtime,ready:true,kimi});
      }
      await superAgentReady();
      console.log(`连接检查通过：iPhone → Along Host → DSH (${new Date().toISOString()})`);
      return respond(res,200,{along:true,runtime,ready:true,dsh:true});
    }
    if (req.method==='POST' && path==='/super-agent/tasks') {
      const input=await body(req),runtime=requestedRuntime(input?.runtime);
      const {runtime:_runtime,...dshInput}=input;
      if (runtime===KIMI_RUNTIME) return respond(res,200,await kimiAgent.startTask(dshInput));
      return respond(res,200,await superAgentCall('/along-source/api/tasks',{value:dshInput}));
    }
    if (req.method==='POST' && path==='/super-agent/tasks/status') {
      const input=await body(req),id=requestId(input?.requestId),runtime=requestedRuntime(input?.runtime);
      if (runtime===KIMI_RUNTIME) return respond(res,200,await kimiAgent.taskStatus(id));
      return respond(res,200,await superAgentCall(`/along-source/api/tasks/${encodeURIComponent(id)}`,{method:'GET'}));
    }
    if (req.method==='POST' && path==='/super-agent/goals') {
      const input=await body(req),runtime=requestedRuntime(input?.runtime);
      const goal=cleanGoal(input.goal), snapshot=cleanSnapshot(input.snapshot,goal.domain);
      const message=String(input.message??'').trim();
      if (!message||message.length>800) throw Error('消息长度需在 1 至 800 字之间');
      const history=Array.isArray(input.history)?input.history.slice(-12).map(item=>({role:item.role==='assistant'?'assistant':'user',text:String(item.text??'').slice(0,1200)})).filter(item=>item.text.trim()):[];
      if (runtime===KIMI_RUNTIME) return respond(res,200,await kimiAgent.startGoal({requestId:requestId(input.requestId),goal,snapshot,message,history}));
      const response=await superAgentCall('/along-source/api/goals',{value:{requestId:requestId(input.requestId),goal,snapshot,message,history}});
      return respond(res,200,{...response,run:normalizeGoalRun(response.run)});
    }
    if (req.method==='POST' && path==='/super-agent/goals/status') {
      const input=await body(req),id=requestId(input?.requestId),runtime=requestedRuntime(input?.runtime);
      if (runtime===KIMI_RUNTIME) return respond(res,200,await kimiAgent.goalStatus(id));
      return respond(res,200,normalizeGoalRun(await superAgentCall(`/along-source/api/goals/${encodeURIComponent(id)}`,{method:'GET'})));
    }
    if (req.method==='POST' && path==='/goal/chat') {
      return respond(res,409,{error:'目标输入已升级，请更新 Along 后重试'});
    }
    if (req.method==='POST' && path==='/goal/event') {
      const input=await body(req), goal=cleanGoal(input.goal);
      if (goal.domain!=='health') throw Error('当前只支持健康变化触发');
      const before=cleanSnapshot(input.before,'health'),after=cleanSnapshot(input.after,'health');
      const route=routeHealthChange(before,after,goal.target);
      if (route.decision==='quiet') return respond(res,200,{...route,source:'router'});
      const currentTask=String(input.currentTask??'').slice(0,120);
      const prompt=`你是 Along 的任务调整 Agent。确定性进度由 Along 算好，不要自行修改。不得调用工具，不要给医学建议。只输出 JSON：{"task":"具体可执行的下一步","reason":"解释为什么调整","remaining":${route.remaining}}。目标：${JSON.stringify(goal)}。原任务：${currentTask}。变化：${route.reason}。任务应与剩余 ${route.remaining} 分钟相符；若已完成则建议查看成果。`;
      const suggestion=validateTaskReply(await runExclusive(()=>runTaskCodex(prompt)),route.remaining);
      return respond(res,200,{...route,suggestion,source:'live-along'});
    }
    return respond(res,404,{error:'未找到接口'});
  } catch(error) { respond(res,error.message.includes('正在处理')?429:400,{error:error.message}); }
});
server.listen(port,lanHost,()=>{
  console.log(`Along 服务: https://${lanHost}:${port}`);
  console.log(`证书指纹 SHA-256: ${fingerprint}`);
  console.log(`一次性配对码: ${code} (15 分钟有效)`);
  console.log('仅用于可信任的同一 Wi-Fi；退出请按 Ctrl+C。');
});
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
