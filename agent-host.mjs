import {createServer} from 'node:https';
import {randomBytes, randomInt, createHash, timingSafeEqual} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir, networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {mkdirSync, readFileSync, existsSync, chmodSync} from 'node:fs';
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';
import {routeHealthChange, validateGoalReply, validateTaskReply} from './goal-agent-core.mjs';

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
let tokenHash = null;
let busy = false;
const port = Number(process.env.ALONG_AGENT_PORT) || 4176;
const lanHost = process.env.ALONG_AGENT_HOST || networkInterfaces().en0?.find(item=>item.family==='IPv4'&&!item.internal)?.address || '127.0.0.1';
const harness = new DeepSeekHarness({profile:'sdk',dshHome:join(homedir(),'.dsh'),provider:'deepseek-account',model:'deepseek-flash',initializeTimeoutMs:30_000});

function respond(res,status,data) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(data)); }
async function body(req) {
  let text='';
  for await (const chunk of req) { text+=chunk; if (text.length>12_000) throw Error('请求过大'); }
  return JSON.parse(text);
}
function authorized(req) {
  const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  return !!(token && tokenHash && timingSafeEqual(createHash('sha256').update(token).digest(),tokenHash));
}
function cleanGoal(value) {
  const domain=value?.domain;
  if (!['health','finance'].includes(domain)) throw Error('目标类型无效');
  const limit=domain==='health'?10080:10000000;
  const target=value?.target;
  if (!Number.isInteger(target)||target<1||target>limit) throw Error('目标数值无效');
  const title=String(value?.title??'').trim();
  if (!title||title.length>80) throw Error('目标名称无效');
  return {domain,target,title};
}
function cleanSnapshot(value,domain) {
  if (domain==='finance') return {saved:Number.isInteger(value?.saved) && value.saved>=0 ? Math.min(value.saved,10000000) : null, source:'演示数据'};
  const selected=Array.isArray(value?.selectedTypes)?value.selectedTypes.filter(type=>['workout','steps','weight','sleep'].includes(type)):[];
  return {workoutMinutes:selected.includes('workout') && Number.isInteger(value?.workoutMinutes) ? Math.min(Math.max(value.workoutMinutes,0),10080):null, selectedTypes:selected, source:'Apple Health 最小摘要'};
}
function failed(result) {
  const reason=result.events?.find(item=>item.type==='turn/end')?.data?.reason;
  if (reason?.kind==='error') throw Error(`DSH 调用失败：${reason.error?.code ?? reason.error?.message ?? '未知错误'}`);
  return result;
}
async function run(prompt) {
  if (busy) throw Error('Agent 正在处理上一条请求，请稍后再试');
  busy=true;
  try { return failed(await harness.run(prompt)); }
  finally { busy=false; }
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
      pairFailures=5;
      return respond(res,200,{token});
    }
    if (!authorized(req)) return respond(res,401,{error:'请先配对这台 Mac'});
    if (req.method==='POST' && path==='/goal/chat') {
      const input=await body(req);
      const goal=cleanGoal(input.goal), snapshot=cleanSnapshot(input.snapshot,goal.domain);
      const message=String(input.message??'').trim();
      if (!message||message.length>800) throw Error('消息长度需在 1 至 800 字之间');
      const history=Array.isArray(input.history)?input.history.slice(-6).map(item=>({role:item.role==='assistant'?'assistant':'user',text:String(item.text??'').slice(0,800)})):[];
      const prompt=`你是 Along 的目标共创 Agent。只根据下面资料及用户消息对话。不得调用工具，不要给医疗或投资决策建议，不得声称已连接理财账户。先理解目标、约束和可执行的下一步；信息不足可追问。如果目标明确，返回可确认的提案。只能输出 JSON：{"reply":"给用户的简洁回答","proposal":null 或 {"title":"目标标题","target":整数,"task":"下一步任务","reason":"提案依据"}}。健康目标 target 单位是每周运动分钟，范围 1-10080；理财目标 target 单位是人民币元，范围 1-10000000。不能改变目标类型。提案尚未执行，必须由用户确认。\n当前目标：${JSON.stringify(goal)}\n当前摘要：${JSON.stringify(snapshot)}\n最近对话：${JSON.stringify(history)}\n用户消息：${message}`;
      const output=validateGoalReply(await run(prompt),goal.domain);
      return respond(res,200,{...output,source:'live-dsh'});
    }
    if (req.method==='POST' && path==='/goal/event') {
      const input=await body(req), goal=cleanGoal(input.goal);
      if (goal.domain!=='health') throw Error('当前只支持健康变化触发');
      const before=cleanSnapshot(input.before,'health'),after=cleanSnapshot(input.after,'health');
      const route=routeHealthChange(before,after,goal.target);
      if (route.decision==='quiet') return respond(res,200,{...route,source:'router'});
      const currentTask=String(input.currentTask??'').slice(0,120);
      const prompt=`你是 Along 的任务调整 Agent。确定性进度由 Along 算好，不要自行修改。不得调用工具，不要给医学建议。只输出 JSON：{"task":"具体可执行的下一步","reason":"解释为什么调整","remaining":${route.remaining}}。目标：${JSON.stringify(goal)}。原任务：${currentTask}。变化：${route.reason}。任务应与剩余 ${route.remaining} 分钟相符；若已完成则建议查看成果。`;
      const suggestion=validateTaskReply(await run(prompt),route.remaining);
      return respond(res,200,{...route,suggestion,source:'live-dsh'});
    }
    return respond(res,404,{error:'未找到接口'});
  } catch(error) { respond(res,error.message.includes('正在处理')?429:400,{error:error.message}); }
});
server.listen(port,lanHost,()=>{
  console.log(`Along Agent Host: https://${lanHost}:${port}`);
  console.log(`证书指纹 SHA-256: ${fingerprint}`);
  console.log(`一次性配对码: ${code} (15 分钟有效)`);
  console.log('仅用于可信任的同一 Wi-Fi；退出请按 Ctrl+C。');
});
process.on('SIGINT',async()=>{server.close();await harness.close();process.exit(0);});
