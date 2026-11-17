import {rememberDailyAction,includeEarlierDailyAction,pruneDailyActions} from './daily-action-history.mjs';
import {createServer} from 'node:https';
import {randomBytes, randomInt, createHash, timingSafeEqual} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir, networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync} from 'node:fs';
import {routeHealthChange, validateGoalReply, normalizeGoalReply, validateTaskReply} from '../web/goal-agent-core.mjs';
import {safeAdaptiveLayout, normalizeAdaptiveLayout} from '../web/adaptive-ui.mjs';
import {runTaskCodex} from './codex-agent.mjs';
import {KimiCodeAgent} from './kimi-code-agent.mjs';
import {DSH_RUNTIME, KIMI_RUNTIME, safeAgentRuntime} from '../web/super-agent.mjs';
import {readJsonBody} from './request-body.mjs';
import {findDailyGrant} from './daily-delegation.mjs';
import {HostError, upstream, statusForError} from './host-error.mjs';
import {createApnsProvider} from './apns.mjs';
import {taskNotifications} from './task-notifications.mjs';
import {createOkxConnection} from './okx-connection.mjs';
import {validateOkxSourceRequest,requireOkxGoal,requireOwnedSourceGoal,reconcileOkxSources} from './source-access.mjs';
import {createBridge, readBridgeToken} from './along-bridge.mjs';
import {agentHealthSnapshot,cleanHealthContext,cleanPlanningContext,validateReassessment,SLEEP_REMINDER_CRITERIA,DAILY_ACTIONS_CRITERIA,parseDailyActionReply} from '../web/contextual-planning.mjs';

const dir = process.env.ALONG_AGENT_STATE_DIR||join(homedir(), '.along', 'agent-host');
mkdirSync(dir, {recursive:true, mode:0o700});
const okxConnection=createOkxConnection({dir:join(dir,'okx-connections')});
function pruneExpiredPlans() {
  try {pruneDailyActions(dir);} catch {console.warn('Along 未能清理已过期的安排索引');}
}
pruneExpiredPlans();
setInterval(pruneExpiredPlans,60_000).unref();
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
let identity = null;   // 服务端绑定的配对身份 {userId,deviceId}（001 §4.2：身份只来自这里，不信任请求体自称）
try {
  const saved=JSON.parse(readFileSync(pairingPath,'utf8'));
  if (typeof saved.hash==='string' && /^[a-f0-9]{64}$/.test(saved.hash)) {
    tokenHash=Buffer.from(saved.hash,'hex');
    if (/^u_[0-9a-f]{8}$/.test(saved.user_id??'') && /^d_[0-9a-f]{8}$/.test(saved.device_id??'')) identity={userId:saved.user_id,deviceId:saved.device_id};
  }
} catch (error) { if (error.code!=='ENOENT') throw error; }
const newBoundId=prefix=>prefix+randomBytes(4).toString('hex');
function savePairingBinding() {
  writeFileSync(pairingPath,JSON.stringify({hash:tokenHash.toString('hex'),user_id:identity.userId,device_id:identity.deviceId}),{mode:0o600});
}
// 旧 pairing.json（仅 hash）启动时幂等升级补齐 user_id/device_id：配对 token 不变、手机无感（§2.4.1）。
if (tokenHash&&!identity) {
  identity={userId:newBoundId('u_'),deviceId:newBoundId('d_')};
  savePairingBinding();
}
let busy = false;
const port = Number(process.env.ALONG_AGENT_PORT) || 4176;
const lanHost = process.env.ALONG_AGENT_HOST || networkInterfaces().en0?.find(item=>item.family==='IPv4'&&!item.internal)?.address || '127.0.0.1';
const superAgentURL = (process.env.ALONG_SUPERAGENT_URL || 'http://127.0.0.1:3082').replace(/\/$/,'');
const contextReviewURL=(process.env.ALONG_CONTEXT_REVIEW_URL||superAgentURL).replace(/\/$/,'');
if (process.env.ALONG_CONTEXT_REVIEW_TOKEN_FILE&&!['localhost','127.0.0.1','[::1]'].includes(new URL(contextReviewURL).hostname)) throw Error('专用情境评估凭据只能发送到本机 DSH');
const contextToken=process.env.ALONG_CONTEXT_REVIEW_TOKEN_FILE?readFileSync(process.env.ALONG_CONTEXT_REVIEW_TOKEN_FILE,'utf8').trim():null;
// Host→Along Agent 回环凭证（stage-a-tech-design.md §2.4.3，SD-2）：启动读一次，只在两个 Mac 本机进程内存里走，
// 不发 iPhone、不写运行结果；缺失时旧链路不带 token 照发，新端点按「未配置桥接凭证」503。
const bridgeToken=readBridgeToken();
const bridge=createBridge({url:superAgentURL,token:bridgeToken});
const contextReviewBridge=createBridge({url:contextReviewURL,token:bridgeToken});
const kimiAgent = new KimiCodeAgent({workspace:process.env.ALONG_KIMI_WORKSPACE||process.cwd()});

function respond(res,status,data) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(data)); }
async function body(req) { return readJsonBody(req,32_000); }
function authorized(req) {
  const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  return !!(token && tokenHash && timingSafeEqual(createHash('sha256').update(token).digest(),tokenHash));
}
async function superAgentCall(path,{method='POST',value,contextReview=false}={}) {
  // 回环传输统一由 along-bridge 承载（桥接凭证、超时与错误语义都在它那里，§2.4.3）；
  // 情境评估专用凭证只加在专用 URL 上（专用凭证只发本机 DSH 的校验保持不变）。
  return (contextReview?contextReviewBridge:bridge).call(path,{method,value,contextToken:contextReview&&contextToken?contextToken:null});
}
async function superAgentReady() {
  return bridge.ready();
}
// 目标名称必须真的是字符串：String() 会把对象变成 "[object Object]"，
// 这样的假标题会被当成用户目标送进模型。
function cleanGoalTitle(value) {
  const title=typeof value==='string'?value.trim():'';
  if (!title||title.length>80) throw Error('目标名称无效');
  return title;
}
// 客户端发来的自由文本也必须真的是字符串：String() 兜底会把对象变成
// "[object Object]"，混过长度检查后送进模型。
function clientText(value) {
  return typeof value==='string'?value:'';
}
function cleanGoal(value,contextReview=false) {
  const domain=value?.domain;
  if (!['health','finance','custom'].includes(domain)) throw Error('目标类型无效');
  if (domain==='custom') {
    return {domain,target:null,title:cleanGoalTitle(value?.title)};
  }
  const limit=domain==='health'?10080:10000000;
  const target=value?.target;
  if (contextReview&&domain==='health'&&target===null) return {domain,target:null,title:cleanGoalTitle(value?.title)};
  if (!Number.isInteger(target)||target<1||target>limit) throw Error('目标数值无效');
  return {domain,target,title:cleanGoalTitle(value?.title)};
}
function cleanSnapshot(value,domain,goalTarget=null) {
  if (domain==='custom' && !value?.planning) return {source:'暂无连接'};
  if (domain==='finance') return {saved:Number.isInteger(value?.saved) && value.saved>=0 ? Math.min(value.saved,10000000) : null, source:'演示数据'};
  const snapshot=agentHealthSnapshot(value);
  if (value?.planning && !snapshot.contextReviewAllowed) throw Error('请先在 iPhone 的 Apple Health 管理页确认用于情境评估的摘要');
  const planning=cleanPlanningContext(value?.planning);
  if (value?.planning && !planning) throw Error('情境评估的版本无效');
  if (planning) {
    if (value.planning.dailyDelegation!=null&&(!planning.dailyDelegation||
      (planning.dailyDelegation.goalKey==='health'?'health':'custom')!==domain||
      !planning.dailyDelegation.topics.every(t=>snapshot.selectedTypes.includes(t)))) throw Error('每日委托超出当前目标的数据范围');
    planning.previous=cleanHealthContext({...planning.previous,
      comparisonHistoryAllowed:snapshot.comparisonHistoryAllowed&&planning.previous.comparisonHistoryAllowed,
      selectedTypes:planning.previous.selectedTypes.filter(type=>snapshot.selectedTypes.includes(type))});
    if (domain!=='health'||planning.weeklyWorkoutMinutes!==goalTarget) planning.weeklyWorkoutMinutes=null;
    // Both runtimes receive these criteria with the consent-scoped observations.
    planning.reviewCriteria=[
      'baselineKind=initial 表示首次评估。相邻读数相同或 changes 为空时，也要依据当前 recentHistory 的两个七天窗口、当周进度及用户反馈复核任务。',
      '窗口左闭右开。workout.value 是窗口内记录的运动总分钟数，count 是记录次数。sleep.value 是有记录日的平均睡眠分钟，weight.value 是有记录日每日末次体重的平均公斤数。daysWithData 是实际有记录的天数。空值是未知，单日或覆盖稀疏时说明限制，不据此断言长期趋势。',
      '缺少某项双周窗口时，仍可基于已经提供的上一晚、前一晚、七天睡眠平均或已记录的运动时段作有限判断；单次体重无法说明变化方向。',
      '当前自然周的 workoutMinutes 应与明确的 weeklyWorkoutMinutes（分钟/周）比较。滚动七天与自然周分开计算。其他目标按 goalIntent 判断，不把目标期限或体重当运动分钟。',
      '结合目标、剩余日期与已有安排，给出支持你判断的时间、数值和任务。若长期任务仍正确但下一步太笼统，考虑一个有依据、可执行的阶段任务。区别补量候选与用户约好的固定活动，已有安排适合时可以保留。',
      SLEEP_REMINDER_CRITERIA,
      ...(planning.dailyDelegation?[DAILY_ACTIONS_CRITERIA]:[]),
      'protectedTaskIds 的正文不可见，原样保留。不得猜测其作用或重复补排。可以提出确有依据、与原安排无冲突的行动；若缺失的信息实质影响下一步，只问一个具体问题。',
    ].join('\n');
    if (!planning.now||!planning.revisionId) throw Error('情境评估的版本或时间无效');
  }
  return {...snapshot,...(planning?{planning}:{})};
}
async function runExclusive(operation) {
  if (busy) throw Error('Along 正在处理上一条请求，请稍后再试');
  busy=true;
  try { return await operation(); }
  finally { busy=false; }
}
// ---- 阶段 A 新链路（docs/stage-a-tech-design.md §2.4/§4.2）----
// 新旧单消费开关：off（默认）= 新端点 503、旧链路照旧；on = 新端点生效、旧 /super-agent/goals|tasks
// 的 DSH 分支 409「已切换新链路」。回退 = 改回 off，Along Agent 业务库与 DSH 状态不清（BC-09-03/04）。
const eventIngest = process.env.ALONG_EVENT_INGEST === 'on';
const newLinkPaths = new Set(['/events', '/sync', '/sync/ack', '/notifications/device', '/notifications/scheduled']);
let pairingRegistered = false;
function requireEventIngest() {
  if (!eventIngest) throw new HostError('新链路未开启：设置 ALONG_EVENT_INGEST=on 后重启 Along 服务',503);
}
function requireBridgeCredential() {
  if (!bridgeToken) throw new HostError('未配置桥接凭证：设置 ALONG_BRIDGE_TOKEN_FILE 后重启 Along 服务',503);
}
function boundPairing() {
  if (!identity) throw new HostError('配对身份缺失，请重新配对',403);
  return identity;
}
// 自报身份检查（BC-07-04 接口侧防线）：user_id/device_id 只能由服务端绑定的配对会话提供，请求体自称一律不收。
function claimedIdentityField(input) {
  if (input===null||typeof input!=='object'||Array.isArray(input)) return null;
  return 'user_id' in input ? 'user_id' : ('device_id' in input ? 'device_id' : null);
}
// 配对身份注册进 Along Agent（幂等可重试，§2.4.1）：Along Agent 幂等 upsert user 行并把 user_id 加入 sources.along.allowed；
// Along Agent 暂不可达时下一次新端点调用会再试。
async function ensurePairingRegistered() {
  if (pairingRegistered || !identity || !bridgeToken) return;
  try {
    // Along Agent 契约要求全部 /along-source/api/* 用头传绑定身份（缺头 403 invalid_identity），
    // 注册调用与其他回环调用一样带上 identity，body 与头来自同一个绑定对象。
    const registeredIdentity=identity;
    await bridge.call('/along-source/api/pairing',{value:{user_id:identity.userId,device_id:identity.deviceId},identity,timeout:5_000});
    if (registeredIdentity===identity) pairingRegistered = true;
  } catch (error) { console.warn('Along 未能把配对身份注册到 Along Source（稍后自动重试）：',error.message); }
}
ensurePairingRegistered();
function readSyncPage(who,afterSeq,limit,conversationVersion=1) {
  return upstream(()=>bridge.call(`/along-source/api/sync?user_id=${encodeURIComponent(who.userId)}&after_seq=${afterSeq}&limit=${limit}${conversationVersion===1?'&conversation_version=1':''}`,{method:'GET',identity:who}));
}
const notifications=taskNotifications({dir,identity:()=>identity,readPage:readSyncPage,send:createApnsProvider()});
let registeringForNotifications=false;
async function dispatchNotifications() {
  if (!eventIngest||!bridgeToken||!notifications.active(identity)||registeringForNotifications) return;
  if (!pairingRegistered) {
    registeringForNotifications=true;
    try {await ensurePairingRegistered();} finally {registeringForNotifications=false;}
  }
  if (pairingRegistered) await notifications.dispatch();
}
setInterval(dispatchNotifications,3000).unref();
// 新端点全部 POST（iOS 桥 agentRequest 固定 POST，不改桥语义）：/events 事件接收（回执按 Along Agent 原状态码
// 透传：200 accepted/duplicate、400 rejected、409 conflict），/sync 同步拉取，/sync/ack 确认。
async function handleAlongNewLink(req,res,path) {
  requireEventIngest();
  requireBridgeCredential();
  const who=boundPairing();
  const input=await body(req);
  if (claimedIdentityField(input)) {
    const legalEventId=typeof input?.event_id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(input.event_id);
    return respond(res,400,path==='/events'
      ?{status:'rejected',...(legalEventId?{event_id:input.event_id}:{}),reason:'identity_in_body'}
      :{error:'身份字段只能由配对会话提供'});
  }
  if (!authorized(req)||who!==identity) throw new HostError('配对已变更',403);
  if (path==='/notifications/scheduled') return respond(res,200,notifications.scheduled(who,input));
  if (path==='/notifications/device') return respond(res,200,notifications.register(who,input));
  await ensurePairingRegistered();
  if (!pairingRegistered) throw new HostError('配对身份尚未登记到 Along，请稍后重试',503);
  if (path==='/events') {
    // /events 在 Along Agent 侧含 DSH 投递触发，15s 不够 → 30s（§2.4.3）。
    const {status,result}=await upstream(()=>bridge.receipt('/along-source/api/events',{value:input,identity:who,timeout:30_000}));
    return respond(res,status,result);
  }
  if (path==='/sync') {
    const afterSeq=Number.isInteger(input?.after_seq)&&input.after_seq>=0?input.after_seq:0;
    const limit=Number.isInteger(input?.limit)?Math.min(Math.max(input.limit,1),200):50;
    const result=await readSyncPage(who,afterSeq,limit,input?.conversation_version===1?1:0);
    await reconcileOkxSources(result,who,{
      isCurrent:()=>identity===who,
      status:goalId=>okxConnection.handle({userId:who.userId,goalId,input:{action:'status'}}),
      readGoal:goalId=>upstream(()=>bridge.call(`/along-source/api/goals/${encodeURIComponent(goalId)}`,{method:'GET',identity:who})),
      disconnect:goalId=>okxConnection.handle({userId:who.userId,goalId,input:{action:'disconnect'},stillAuthorized:()=>identity===who}),
    });
    return respond(res,200,notifications.decorate(who,result,input));
  }
  if (path==='/sync/ack') {
    if (!Array.isArray(input?.seqs)||input.seqs.length===0||!input.seqs.every(seq=>Number.isInteger(seq)&&seq>=1)) throw Error('同步确认序号无效');
    const result=await upstream(()=>bridge.call('/along-source/api/sync/ack',{value:{seqs:input.seqs},identity:who}));
    return respond(res,200,result);
  }
  return respond(res,404,{error:'未找到接口'});
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
function normalizeGoalRun(run,pair=null) {
  if (!run?.result) return run;
  try {
    const domain=run.input?.goal?.domain;
    if (!['health','finance','custom'].includes(domain)) throw Error('Along 返回的目标类型无效');
    const tagged=run.input?.snapshot?.planning?.dailyDelegation||typeof run.result.reply==='string'&&run.result.reply.includes('ALONG_DAILY_ACTIONS_');
    const daily=tagged?parseDailyActionReply(run):{reply:run.result.reply};
    const output=validateGoalReply(normalizeGoalReply({...run.result,reply:daily.reply}),domain,String(run.input?.message??''));
    // 待确认问题这一项要和 Kimi 运行时用同一套口径：否则同一份模型输出，
    // 一边被作废整份目标空间、一边照单全收。
    // 归一放在共享层：两条运行时对同一份模型输出必须给出同一个结论。
    const rawLayout=run.result.layout==null?null:normalizeAdaptiveLayout(run.result.layout,domain);
    const layout=rawLayout==null?null:safeAdaptiveLayout(rawLayout,domain);
    if (run.result.layout!=null && !layout) throw Error('Along 返回的目标空间格式不正确');
    const planning=run.input?.snapshot?.planning;
    const reassessment=planning?validateReassessment({...run.result.reassessment,...(daily.dailyActions?{dailyActions:daily.dailyActions}:{})},layout,planning):null;
    if (planning&&output.proposal) throw Error('情境重排不能修改目标');
    const normalized={...run,result:{...output,layout,...(planning?{reassessment}:{})}};
    if (daily.dailyActions&&pair) {
      try {rememberDailyAction(dir,pair,normalized);} catch {console.warn('Along 未能保存今天的安排索引');}
    }
    return normalized;
  } catch(error) {
    // 输出校验失败是确定性的错误：这一次运行不会再变好，必须落到终态。
    // 抛成 5xx 的话，前端会把它当成「暂时读不到状态」继续轮询，
    // 运行永远停在 working，用户被锁在转圈里最长 30 分钟。
    // Kimi 那条路径就是把校验失败落成终态的，两边要一样。
    return {...run,status:'blocked',statusLabel:'输出需要重试',result:null,error:`DSH 已完成，但输出校验失败：${error.message}`};
  }
}
const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},async(req,res)=>{
  try {
    const path=new URL(req.url,'https://along.local').pathname;
    if (req.method==='GET' && path==='/health') return respond(res,200,{service:'along-agent-host',ready:true,contextReviewVersion:1});
    if (req.method==='POST' && path==='/pair') {
      const input=await body(req);
      if (Date.now()>codeExpiry || pairFailures>=5 || input?.code!==code) {pairFailures++; return respond(res,403,{error:'配对码无效或已过期'});}
      const token=randomBytes(32).toString('hex');
      tokenHash=createHash('sha256').update(token).digest();
      // 新配对覆盖旧绑定（D1 单用户）：同一用户换手机 → user_id 不变、device_id 换新（§2.4.1）。
      identity={userId:identity?.userId||newBoundId('u_'),deviceId:newBoundId('d_')};
      savePairingBinding();
      pairingRegistered=false;
      pairFailures=5;
      ensurePairingRegistered();
      return respond(res,200,{token});
    }
    if (!authorized(req)) return respond(res,401,{error:'请先配对这台 Mac'});
    const recipient=tokenHash.toString('hex');
    if(req.method==='POST'&&path==='/sources/okx') {
      requireEventIngest();requireBridgeCredential();
      const who=boundPairing(),input=validateOkxSourceRequest(await body(req));
      const allowed=async()=>{
        if(identity!==who)return false;
        const detail=await upstream(()=>bridge.call(`/along-source/api/goals/${encodeURIComponent(input.goalId)}`,{method:'GET',identity:who}));
        if(input.action==='disconnect')requireOwnedSourceGoal(detail,who,input.goalId);
        else requireOkxGoal(detail,who,input.goalId);
        return identity===who;
      };
      if(!await allowed())throw new HostError('配对已变化，请重新打开连接',403);
      const {goalId,...command}=input;
      const result=await okxConnection.handle({userId:who.userId,goalId,input:command,stillAuthorized:allowed});
      if(identity!==who)throw new HostError('配对已变化，请重新打开连接',403);
      return respond(res,200,result);
    }
    if (req.method==='POST'&&path==='/super-agent/daily-delegation') {
      const input=await body(req);
      return respond(res,200,{grant:findDailyGrant(dir,tokenHash.toString('hex'),input?.goalKey,input?.anchors)});
    }
    if (req.method==='POST'&&path==='/connection/verify') {
      console.log(`已验证原配对连接 (${new Date().toISOString()})`);
      return respond(res,200,{paired:true});
    }
    if (req.method==='POST' && path==='/connection/status') {
      if (eventIngest) {
        requireBridgeCredential();
        const who=boundPairing();
        await ensurePairingRegistered();
        if (!pairingRegistered) throw new HostError('配对身份尚未登记到 Along，请稍后重试',503);
        await upstream(()=>bridge.call('/along-source/api/goals/along-status-probe',{method:'GET',identity:who}));
        return respond(res,200,{along:true,runtime:DSH_RUNTIME,ready:true,eventProtocol:1,userId:who.userId});
      }
      const input=await body(req),runtime=requestedRuntime(input?.runtime);
      if (runtime===KIMI_RUNTIME) {
        const kimi=await upstream(()=>kimiAgent.ready());
        console.log(`连接检查通过：iPhone → Along Host → Kimi Code Swarm (${new Date().toISOString()})`);
        return respond(res,200,{along:true,runtime,ready:true,kimi});
      }
      await upstream(()=>superAgentReady());
      console.log(`连接检查通过：iPhone → Along Host → DSH (${new Date().toISOString()})`);
      return respond(res,200,{along:true,runtime,ready:true,dsh:true});
    }
    if (req.method==='POST'&&newLinkPaths.has(path)) return await handleAlongNewLink(req,res,path);
    if (req.method==='POST' && path==='/super-agent/tasks') {
      const input=await body(req),runtime=requestedRuntime(input?.runtime);
      // 旧适配器停止消费用户输入：新链路开启后 DSH 分支不再接收（BC-09-03）。
      if (eventIngest&&runtime===DSH_RUNTIME) return respond(res,409,{error:'已切换新链路'});
      const {runtime:_runtime,...dshInput}=input;
      if (dshInput.goal?.domain==='health') dshInput.context=agentHealthSnapshot(dshInput.context);
      if (runtime===KIMI_RUNTIME) return respond(res,200,await upstream(()=>kimiAgent.startTask(dshInput)));
      return respond(res,200,await upstream(()=>superAgentCall('/along-source/api/tasks',{value:dshInput})));
    }
    if (req.method==='POST' && path==='/super-agent/tasks/status') {
      const input=await body(req),id=requestId(input?.requestId),runtime=requestedRuntime(input?.runtime);
      if (runtime===KIMI_RUNTIME) return respond(res,200,await upstream(()=>kimiAgent.taskStatus(id)));
      return respond(res,200,await upstream(()=>superAgentCall(`/along-source/api/tasks/${encodeURIComponent(id)}`,{method:'GET'})));
    }
    if (req.method==='POST' && path==='/super-agent/goals') {
      const input=await body(req),runtime=requestedRuntime(input?.runtime);
      // 旧适配器停止消费用户输入：新链路开启后 DSH 分支不再接收（BC-09-03）。
      if (eventIngest&&runtime===DSH_RUNTIME) return respond(res,409,{error:'已切换新链路'});
      const goal=cleanGoal(input.goal,!!input.snapshot?.planning), snapshot=cleanSnapshot(input.snapshot,goal.domain,goal.target);
      if (snapshot.planning?.dailyDelegation&&runtime!==DSH_RUNTIME) throw Error('每日委托需要 DSH 运行时');
      if (snapshot.planning&&goal.domain==='health') goal.target=snapshot.planning.weeklyWorkoutMinutes;
      // 客户端发来的必须是真字符串：String() 兜底会把对象变成 "[object Object]"，
      // 混过长度检查后送进模型（和目标标题那一条同一个坑）。
      const message=clientText(input.message).trim();
      if (!message||message.length>800) throw Error('消息长度需在 1 至 800 字之间');
      const history=Array.isArray(input.history)?input.history.slice(-12).map(item=>({role:item.role==='assistant'?'assistant':'user',text:clientText(item.text).slice(0,1200)})).filter(item=>item.text.trim()):[];
      // requestId 是客户端给的，要在包上游之前校验：发错了仍然是 400。
      const id=requestId(input.requestId);
      if (snapshot.planning&&snapshot.planning.revisionId!==id) throw Error('情境版本与请求编号不符');
      if (snapshot.planning?.dailyDelegation) {
        try {includeEarlierDailyAction(dir,recipient,snapshot);} catch {console.warn('Along 未能读取今天的安排索引');}
      }
      const goalInput={requestId:id,goal,snapshot,message,history};
      if (runtime===KIMI_RUNTIME) return respond(res,200,await upstream(()=>kimiAgent.startGoal(goalInput)));
      const response=await upstream(()=>superAgentCall('/along-source/api/goals',{value:goalInput,contextReview:!!snapshot.planning}));
      return respond(res,200,{...response,run:await upstream(()=>normalizeGoalRun(response.run,snapshot.planning?.dailyDelegation?recipient:null))});
    }
    if (req.method==='POST' && path==='/super-agent/goals/status') {
      const input=await body(req),id=requestId(input?.requestId),runtime=requestedRuntime(input?.runtime);
      if (runtime===KIMI_RUNTIME) return respond(res,200,await upstream(()=>kimiAgent.goalStatus(id)));
      const raw=await upstream(()=>superAgentCall(`/along-source/api/goals/${encodeURIComponent(id)}`,{method:'GET',contextReview:input.contextReview===true||id.startsWith('along-review-')}));
      return respond(res,200,await upstream(()=>normalizeGoalRun(raw,recipient)));
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
      const currentTask=clientText(input.currentTask).slice(0,120);
      const prompt=`你是 Along 的任务调整 Agent。确定性进度由 Along 算好，不要自行修改。不得调用工具，不要给医学建议。只输出 JSON：{"task":"具体可执行的下一步","reason":"解释为什么调整","remaining":${route.remaining}}。目标：${JSON.stringify(goal)}。原任务：${currentTask}。变化：${route.reason}。任务应与剩余 ${route.remaining} 分钟相符；若已完成则建议查看成果。`;
      const raw=await runExclusive(()=>upstream(()=>runTaskCodex(prompt)));
      const suggestion=await upstream(()=>validateTaskReply(raw,route.remaining));
      return respond(res,200,{...route,suggestion,source:'live-along'});
    }
    return respond(res,404,{error:'未找到接口'});
  } catch(error) { respond(res,statusForError(error),{error:error.message}); }
});
server.listen(port,lanHost,()=>{
  console.log(`Along 服务: https://${lanHost}:${port}`);
  console.log(`证书指纹 SHA-256: ${fingerprint}`);
  console.log(`一次性配对码: ${code} (15 分钟有效)`);
  console.log('仅用于可信任的同一 Wi-Fi；退出请按 Ctrl+C。');
});
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
