import {rememberDailyAction,includeEarlierDailyAction,pruneDailyActions} from './daily-action-history.mjs';
import {createServer} from 'node:https';
import {randomBytes, randomInt, createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {mkdirSync, readFileSync, existsSync, chmodSync} from 'node:fs';
import {stateDir,loadUsers,loadPairings,savePairings,findPairing,consumeUserCode,recordPairingFailure,clearPairingFailures,failLimitFromEnv,newBoundId} from './pairing.mjs';
import {routeHealthChange, validateGoalReply, normalizeGoalReply, validateTaskReply} from '../web/goal-agent-core.mjs';
import {safeAdaptiveLayout, normalizeAdaptiveLayout} from '../web/adaptive-ui.mjs';
import {runTaskCodex} from './codex-agent.mjs';
import {KimiCodeAgent} from './kimi-code-agent.mjs';
import {DSH_RUNTIME, KIMI_RUNTIME, AGENT_RUN_TIMEOUT_MS, safeAgentRuntime} from '../web/super-agent.mjs';
import {readJsonBody} from './request-body.mjs';
import {findDailyGrant} from './daily-delegation.mjs';
import {HostError, upstream, statusForError} from './host-error.mjs';
import {createApnsProvider} from './apns.mjs';
import {taskNotifications} from './task-notifications.mjs';
import {createOkxConnection} from './okx-connection.mjs';
import {createSourceJournal,createHostSourceEventBridge} from './source-event-bridge.mjs';
import {createDeviceSourceGateway} from './device-source-gateway.mjs';
import {createDeviceSourceRoute,deviceAwareSourceConnection} from './device-source-routes.mjs';
import {validateOkxSourceRequest,requireOkxGoal,requireOwnedSourceGoal,reconcileOkxSources} from './source-access.mjs';
import {createBridge, readBridgeToken} from './along-bridge.mjs';
import {agentHealthSnapshot,cleanHealthContext,cleanPlanningContext,validateReassessment,SLEEP_REMINDER_CRITERIA,DAILY_ACTIONS_CRITERIA,parseDailyActionReply} from '../web/contextual-planning.mjs';

const dir = stateDir();
mkdirSync(dir, {recursive:true, mode:0o700});
const sourceJournal=createSourceJournal({dir:join(dir,'source-events')});
const okxConnection=createOkxConnection({dir:join(dir,'okx-connections'),sourceJournal});
const deviceSources=createDeviceSourceGateway({dir:join(dir,'device-sources'),journal:sourceJournal});
const sourceConnections=deviceAwareSourceConnection({gateway:deviceSources,legacy:okxConnection,binding:currentBinding});
function pruneExpiredPlans() {
  try {pruneDailyActions(dir);} catch {console.warn('Along 未能清理已过期的安排索引');}
}
pruneExpiredPlans();
setInterval(pruneExpiredPlans,60_000).unref();
const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
// 证书参数（docs/cloud-deploy-multi-user.md §4 M4）：ALONG_TLS_DAYS/ALONG_TLS_CN 只在生成时生效，
// 默认 30 天 + CN=Along Local Agent 保持本地行为；云端 compose 设 3650 天 + 域名 CN（§3.1）。
// 证书与状态卷同生命周期，重启不换：改参数换证书须删卷内 cert/key 后重启（§6.4 步骤 10）。
// 非正整数的 ALONG_TLS_DAYS 回落 30 天不抛错：到期时间会打进启动横幅，冒烟时一眼可见。
const tlsDays=(()=>{const value=Number(process.env.ALONG_TLS_DAYS);return Number.isInteger(value)&&value>=1?value:30;})();
const tlsCN=process.env.ALONG_TLS_CN||'Along Local Agent';
if (!existsSync(key) || !existsSync(cert)) {
  execFileSync('openssl', ['req','-x509','-newkey','rsa:3072','-nodes','-keyout',key,'-out',cert,'-days',String(tlsDays),'-subj',`/CN=${tlsCN}`]);
  chmodSync(key,0o600);
}
const certDER = execFileSync('openssl',['x509','-in',cert,'-outform','DER']);
const fingerprint = createHash('sha256').update(certDER).digest('hex').toUpperCase();
// 横幅打印到期时间（M4，§3.7）：从证书文件读取，反映实际在用的证书而不是本次 env。
const certExpiry = execFileSync('openssl',['x509','-in',cert,'-noout','-enddate']).toString().trim().replace(/^notAfter=/,'');
// 多用户形态开关 = users.json 存在性（docs/cloud-deploy-multi-user.md §3.2）：存在则启动不生成通用码、
// /pair 只认每用户一次性码；缺失即本地单用户形态，行为与今天一致（唯一例外：失败限速，两模式统一）。
// users.json 格式无效直接抛错起不来，不静默降级（那会往容器日志打通用码，§3.7）。
const multiUser = loadUsers(dir)!==null;
const code = multiUser?null:String(randomInt(10000000, 99999999));
const codeExpiry = multiUser?0:Date.now() + 15*60_000;
const pairFailLimit = failLimitFromEnv();
// 绑定表 pairings.json（数组，每用户一条）；旧单对象 pairing.json 启动时幂等升级为一元数组。
// M2 起没有模块级 identity/tokenHash 单例：身份一律每请求从绑定表解析（见下方 resolveBinding/
// stillPaired/currentBinding），后台泵按绑定表逐用户处理。
let pairings = loadPairings(dir);
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
const kimiAgent = new KimiCodeAgent({workspace:process.env.ALONG_KIMI_WORKSPACE||process.cwd(),statePath:join(dir,'kimi-runs.json')});
// ---- 云端 DSH runner（docs/cloud-deploy-multi-user.md §3.5 M3，SD-3）----
// ALONG_DSH_RUNNER_URL 指向 compose 内网的 deploy/agent-runner.mjs 时，/super-agent/goals|tasks
// 与 /super-agent/goals/status|tasks/status 的 DSH 分支改走云端 runner（同步一次性调用）；
// 未设置时走既有 Mac bridge，行为字节不变。runner 返回的 run 一律先过 normalizeGoalRun
// （validateGoalReply+safeAdaptiveLayout+validateReassessment），解析失败/校验失败落终态 blocked。
// runner-token 是服务端内部凭证：只在 host↔agent 内网请求头里走，不发 iPhone、不写日志与运行结果。
const dshRunnerURL=(process.env.ALONG_DSH_RUNNER_URL||'').replace(/\/$/,'');
const runnerTokenFile=process.env.ALONG_RUNNER_TOKEN_FILE;
const dshRunnerToken=runnerTokenFile?readBridgeToken(runnerTokenFile):null;
if (dshRunnerURL&&!dshRunnerToken) throw Error('云端 DSH runner 需要 runner-token：设置 ALONG_RUNNER_TOKEN_FILE 后重启 Along 服务');
async function runnerCall(path,{method='GET',value,user=null,timeout=15_000}={}) {
  let response;
  try {
    response=await fetch(`${dshRunnerURL}${path}`,{method,
      headers:{...(dshRunnerToken?{'runner-token':dshRunnerToken}:{}),...(user?{'x-along-user':user}:{}),...(value===undefined?{}:{'content-type':'application/json'})},
      ...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(timeout)});
  } catch(error) { throw new HostError(`云端 DSH runner 暂不可用：${error.message}`,502); }
  let result;
  try { result=await response.json(); } catch { throw new HostError(`云端 DSH runner 返回了无效响应（${response.status}）`,502); }
  if (!response.ok) throw new HostError(result?.error||`云端 DSH runner 请求失败（${response.status}）`,502);
  return result;
}
// runner 的回执必须是本次请求自己的运行记录：requestId 对不上的一律按上游故障拒绝，
// 不能把别人的（或上一次的）运行当成这次的结果。
function runnerRun(envelope,expectedId,kind) {
  const run=envelope?.run;
  const matchingKind=kind==='goal'?run?.version===1&&run.kind==='goal':run?.version===2&&run.kind!=='goal';
  if (!matchingKind||run.requestId!==expectedId||run.runtime!==DSH_RUNTIME||run.actual!==true) {
    throw new HostError('云端 DSH runner 返回了与本次请求不匹配的运行记录',502);
  }
  return run;
}
async function runnerGoalStart(userId,input,pair) {
  const run=runnerRun(await runnerCall('/run',{method:'POST',value:{userId,requestId:input.requestId,kind:'goal',input},timeout:AGENT_RUN_TIMEOUT_MS+60_000}),input.requestId,'goal');
  return {run:cloudGoalResult(run,pair,Boolean(input.snapshot.planning))};
}
async function runnerGoalStatus(userId,id,pair) {
  const run=runnerRun(await runnerCall(`/run/${encodeURIComponent(id)}`,{user:userId}),id,'goal');
  return cloudGoalResult(run,pair);
}
function cloudGoalResult(run,pair,expectsPlanning) {
  // Lookup uses the classification stored with the original Host-validated input.
  const planning=run.input?.snapshot?.planning;
  if (run.result&&((planning!==null&&planning?.revisionId!==run.requestId)||
      (expectsPlanning!==undefined&&expectsPlanning!==Boolean(planning)))) {
    throw new HostError('云端 DSH runner 返回了与本次请求不匹配的情境版本',502);
  }
  const {input,applyValidatedGoal:_untrusted,...wire}=normalizeGoalRun(run,pair);
  const autoApply=wire.status==='done'&&wire.result&&planning===null;
  return {...wire,...(input?{input:{goal:input.goal,message:input.message}}:{}),
    ...(autoApply?{applyValidatedGoal:true}:{})};
}
async function runnerTaskStart(userId,input) {
  const id=requestId(input.requestId);
  const run=runnerRun(await runnerCall('/run',{method:'POST',value:{userId,requestId:id,kind:'task',input:{...input,requestId:id}},timeout:AGENT_RUN_TIMEOUT_MS+60_000}),id,'task');
  return {run};
}
async function runnerTaskStatus(userId,id) {
  return runnerRun(await runnerCall(`/run/${encodeURIComponent(id)}`,{user:userId}),id,'task');
}
const deviceSourceRoute=createDeviceSourceRoute({gateway:deviceSources,stillBound:stillPaired,
  readGoal:(who,goalId)=>upstream(()=>bridge.call(`/along-source/api/goals/${encodeURIComponent(goalId)}`,{method:'GET',identity:who})),
  retireLegacy:(who,goalId)=>okxConnection.handle({userId:who.userId,goalId,input:{action:'disconnect'},stillAuthorized:()=>stillPaired(who)}),
  pump:who=>sourceEvents.pump(who),
});

function respond(res,status,data) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(data)); }
async function body(req) { return readJsonBody(req,32_000); }
// 按绑定表鉴权（M1）：命中返回该请求自己的绑定 {hash,user_id,device_id}，未命中 null（文案不变）。
function authorized(req) {
  const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  return token?findPairing(pairings,token):null;
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
// /goal/event 每用户一把锁（docs/cloud-deploy-multi-user.md §3.2 M2）：不同用户的健康变化
// 处理互不阻塞；同一用户并发第二条仍返回现有 429 文案。
const busyUsers=new Set();
async function runExclusive(userId,operation) {
  if (busyUsers.has(userId)) throw Error('Along 正在处理上一条请求，请稍后再试');
  busyUsers.add(userId);
  try { return await operation(); }
  finally { busyUsers.delete(userId); }
}
// ---- 阶段 A 新链路（docs/stage-a-tech-design.md §2.4/§4.2）----
// 新旧单消费开关：off（默认）= 新端点 503、旧链路照旧；on = 新端点生效、旧 /super-agent/goals|tasks
// 的 DSH 分支 409「已切换新链路」。回退 = 改回 off，Along Agent 业务库与 DSH 状态不清（BC-09-03/04）。
const eventIngest = process.env.ALONG_EVENT_INGEST === 'on';
const newLinkPaths = new Set(['/events', '/sync', '/sync/ack', '/notifications/device', '/notifications/scheduled']);
function requireEventIngest() {
  if (!eventIngest) throw new HostError('新链路未开启：设置 ALONG_EVENT_INGEST=on 后重启 Along 服务',503);
}
function requireBridgeCredential() {
  if (!bridgeToken) throw new HostError('未配置桥接凭证：设置 ALONG_BRIDGE_TOKEN_FILE 后重启 Along 服务',503);
}
// ---- 每请求身份（docs/cloud-deploy-multi-user.md §3.2 M2）----
// 身份一律来自请求自己的 token 在绑定表中的命中（authorized），不再有模块级单例。
// 一致性复查 = 该绑定（user+device）仍然在表中：同一用户重新配对会整条替换绑定，
// 旧绑定的守卫随即失效；其他用户的绑定不受影响。
function stillPaired(who) {
  return Boolean(who)&&pairings.some(entry=>entry.user_id===who.userId&&entry.device_id===who.deviceId);
}
function currentBinding(userId) {
  const entry=pairings.find(item=>item.user_id===userId);
  return entry?{userId:entry.user_id,deviceId:entry.device_id}:null;
}
function resolveBinding(req) {
  const entry=authorized(req);
  if (!entry) throw new HostError('配对身份缺失，请重新配对',403);
  return {userId:entry.user_id,deviceId:entry.device_id};
}
// 自报身份检查（BC-07-04 接口侧防线）：user_id/device_id 只能由服务端绑定的配对会话提供，请求体自称一律不收。
function claimedIdentityField(input) {
  if (input===null||typeof input!=='object'||Array.isArray(input)) return null;
  return 'user_id' in input ? 'user_id' : ('device_id' in input ? 'device_id' : null);
}
// 配对身份注册进 Along Agent（幂等可重试，§2.4.1，按用户各自登记）：Along Agent 幂等 upsert user 行
// 并把 user_id 加入 sources.along.allowed；Along Agent 暂不可达时下一次新端点调用会再试。
const registeredUsers=new Set();
async function ensurePairingRegistered(who) {
  if (!who||registeredUsers.has(who.userId)||!bridgeToken) return;
  try {
    // Along Agent 契约要求全部 /along-source/api/* 用头传绑定身份（缺头 403 invalid_identity），
    // 注册调用与其他回环调用一样带上 identity，body 与头来自同一个绑定对象。
    await bridge.call('/along-source/api/pairing',{value:{user_id:who.userId,device_id:who.deviceId},identity:who,timeout:5_000});
    // 注册期间绑定被替换（重新配对）就不标记：新绑定会由 /pair 或下一次调用重新注册。
    if (stillPaired(who)) registeredUsers.add(who.userId);
  } catch (error) { console.warn('Along 未能把配对身份注册到 Along Source（稍后自动重试）：',error.message); }
}
// 启动即登记既有绑定（每用户各一条；多用户形态下每个绑定都单独注册）。
for (const entry of pairings) ensurePairingRegistered({userId:entry.user_id,deviceId:entry.device_id});
function readSyncPage(who,afterSeq,limit,conversationVersion=1) {
  return upstream(()=>bridge.call(`/along-source/api/sync?user_id=${encodeURIComponent(who.userId)}&after_seq=${afterSeq}&limit=${limit}${conversationVersion===1?'&conversation_version=1':''}`,{method:'GET',identity:who}));
}
// 通知登记按用户各一份实例（M2）：notification-device.<userId>.json 互不覆盖；
// 后台泵按绑定表逐用户派发。
const notificationServices=new Map();
function notificationService(userId) {
  let service=notificationServices.get(userId);
  if (!service) {
    service=taskNotifications({dir,userId,binding:()=>currentBinding(userId),
      readPage:(who,cursor,limit)=>readSyncPage(who,cursor,limit),send:createApnsProvider()});
    notificationServices.set(userId,service);
  }
  return service;
}
const registeringUsers=new Set();
async function dispatchNotifications() {
  if (!eventIngest||!bridgeToken) return;
  for (const entry of [...pairings]) {
    const who={userId:entry.user_id,deviceId:entry.device_id};
    const service=notificationService(who.userId);
    if (!service.active(who)) continue;
    if (!registeredUsers.has(who.userId)) {
      if (registeringUsers.has(who.userId)) continue;
      registeringUsers.add(who.userId);
      try { await ensurePairingRegistered(who); } finally { registeringUsers.delete(who.userId); }
    }
    if (registeredUsers.has(who.userId)) await service.dispatch();
  }
}
setInterval(dispatchNotifications,3000).unref();
// 新端点全部 POST（iOS 桥 agentRequest 固定 POST，不改桥语义）：/events 事件接收（回执按 Along Agent 原状态码
// 透传：200 accepted/duplicate、400 rejected、409 conflict），/sync 同步拉取，/sync/ack 确认。
async function handleAlongNewLink(req,res,path) {
  requireEventIngest();
  requireBridgeCredential();
  const who=resolveBinding(req);
  const input=await body(req);
  if (claimedIdentityField(input)) {
    const legalEventId=typeof input?.event_id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(input.event_id);
    return respond(res,400,path==='/events'
      ?{status:'rejected',...(legalEventId?{event_id:input.event_id}:{}),reason:'identity_in_body'}
      :{error:'身份字段只能由配对会话提供'});
  }
  if (!stillPaired(who)) throw new HostError('配对已变更',403);
  if (path==='/notifications/scheduled') return respond(res,200,notificationService(who.userId).scheduled(who,input));
  if (path==='/notifications/device') return respond(res,200,notificationService(who.userId).register(who,input));
  await ensurePairingRegistered(who);
  if (!registeredUsers.has(who.userId)) throw new HostError('配对身份尚未登记到 Along，请稍后重试',503);
  if (path==='/events') {
    const eventType=input?.payload?.event_type??input?.event_type;
    if(typeof eventType==='string'&&eventType.startsWith('along.source_')) {
      return respond(res,400,{status:'rejected',event_id:input?.event_id,reason:'native_source_route_required'});
    }
    // /events 在 Along Agent 侧含 DSH 投递触发，15s 不够 → 30s（§2.4.3）。
    const {status,result}=await upstream(()=>bridge.receipt('/along-source/api/events',{value:input,identity:who,timeout:30_000}));
    return respond(res,status,result);
  }
  if (path==='/sync') {
    const afterSeq=Number.isInteger(input?.after_seq)&&input.after_seq>=0?input.after_seq:0;
    const limit=Number.isInteger(input?.limit)?Math.min(Math.max(input.limit,1),200):50;
    const result=await readSyncPage(who,afterSeq,limit,input?.conversation_version===1?1:0);
    await reconcileOkxSources(result,who,{
      isCurrent:()=>stillPaired(who),
      status:goalId=>sourceConnections.handle({userId:who.userId,goalId,input:{action:'status'}}),
      readGoal:goalId=>upstream(()=>bridge.call(`/along-source/api/goals/${encodeURIComponent(goalId)}`,{method:'GET',identity:who})),
      disconnect:(goalId,revokeIf)=>sourceConnections.handle({userId:who.userId,goalId,input:{action:'disconnect'},stillAuthorized:()=>stillPaired(who),revokeIf}),
    });
    return respond(res,200,notificationService(who.userId).decorate(who,result,input));
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
    const planning=run.input?.snapshot?.planning;
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
      const now=Date.now();
      // users.json 每次 /pair 重读：部署者增删用户即刻生效，无需重启（静态表，文件即事实）。
      const allowedUsers=loadUsers(dir);
      // 公网配对在比对码之前检查全局失败窗口（默认 15 分钟 10 次，ALONG_PAIR_FAIL_LIMIT 只许调严）。
      // 窗口满与未命中共用 403，不回显提交值。Mac 本地启动码沿用自己的核验路径。
      let matched;
      if (allowedUsers) {
        matched=consumeUserCode(dir,input?.code,now,pairFailLimit,allowedUsers);
      } else if (typeof input?.code==='string'&&now<=codeExpiry&&input.code===code) {
        clearPairingFailures(dir,now);
        matched={ok:true,userId:pairings[0]?.user_id||newBoundId('u_')};
      } else {
        matched=recordPairingFailure(dir,now,pairFailLimit);
      }
      if (!matched.ok) return respond(res,403,{error:'配对码无效或已过期'});
      const token=randomBytes(32).toString('hex');
      const entry={hash:createHash('sha256').update(token).digest('hex'),user_id:matched.userId,device_id:newBoundId('d_')};
      // 多用户：按用户 upsert（同一用户换手机覆盖自己的旧绑定、user_id 不变，别人不受影响）；
      // 本地单用户：整表保留一条，user_id 沿用（D1 单用户，§2.4.1）。
      pairings=allowedUsers?[...pairings.filter(item=>item.user_id!==matched.userId),entry]:[entry];
      savePairings(dir,pairings);
      // 该用户的登记状态复位并立即向 Along Agent 重注册（新 device_id 覆盖旧记录，fire-and-forget）。
      registeredUsers.delete(entry.user_id);
      ensurePairingRegistered({userId:entry.user_id,deviceId:entry.device_id});
      return respond(res,200,{token,...(dshRunnerURL&&!eventIngest?{runtime:DSH_RUNTIME}:{})});
    }
    // 每请求身份（M2）：绑定只来自请求自己的 token 在绑定表中的命中；recipient 用同一绑定
    // 的 token 哈希（每日委托索引按 pair 哈希分键，多绑定后单例不再代表任何一人）。
    const binding=authorized(req);
    if (!binding) return respond(res,401,{error:'请先配对这台 Mac'});
    const who={userId:binding.user_id,deviceId:binding.device_id};
    const recipient=binding.hash;
    if(req.method==='POST'&&path==='/sources/device') {
      requireEventIngest();requireBridgeCredential();
      await ensurePairingRegistered(who);
      if(!stillPaired(who))throw new HostError('配对已变化',403);
      if(!registeredUsers.has(who.userId))throw new HostError('配对身份尚未登记到 Along，请稍后重试',503);
      // Private normalized history is bounded separately; ordinary browser routes keep32KiB.
      const input=await readJsonBody(req,Math.ceil(2.2*1024*1024));
      if(!stillPaired(who))throw new HostError('配对已变化',403);
      const result=await deviceSourceRoute(input,who);
      return respond(res,result.status,result.value);
    }
    if(req.method==='POST'&&path==='/sources/okx') {
      requireEventIngest();requireBridgeCredential();
      const input=validateOkxSourceRequest(await body(req));
      if(['connect','refresh'].includes(input.action))throw new HostError('请更新 Along，在 iPhone 上连接或刷新；凭证只保存在采集设备',409);
      const allowed=async()=>{
        if(!stillPaired(who))return false;
        const detail=await upstream(()=>bridge.call(`/along-source/api/goals/${encodeURIComponent(input.goalId)}`,{method:'GET',identity:who}));
        if(input.action==='disconnect')requireOwnedSourceGoal(detail,who,input.goalId);
        else requireOkxGoal(detail,who,input.goalId);
        return stillPaired(who);
      };
      if(!await allowed())throw new HostError('配对已变化，请重新打开连接',403);
      const {goalId,...command}=input;
      const result=await sourceConnections.handle({userId:who.userId,goalId,input:command,stillAuthorized:allowed});
      if(!stillPaired(who))throw new HostError('配对已变化，请重新打开连接',403);
      return respond(res,200,result);
    }
    if (req.method==='POST'&&path==='/super-agent/daily-delegation') {
      const input=await body(req);
      return respond(res,200,{grant:findDailyGrant(dir,recipient,input?.goalKey,input?.anchors)});
    }
    if (req.method==='POST'&&path==='/connection/verify') {
      console.log(`已验证原配对连接 (${new Date().toISOString()})`);
      return respond(res,200,{paired:true});
    }
    if (req.method==='POST' && path==='/connection/status') {
      if (eventIngest) {
        requireBridgeCredential();
        await ensurePairingRegistered(who);
        if (!registeredUsers.has(who.userId)) throw new HostError('配对身份尚未登记到 Along，请稍后重试',503);
        await upstream(()=>bridge.call('/along-source/api/goals/along-status-probe',{method:'GET',identity:who}));
        return respond(res,200,{along:true,runtime:DSH_RUNTIME,ready:true,eventProtocol:1,userId:who.userId});
      }
      const input=await body(req),runtime=requestedRuntime(input?.runtime);
      if (runtime===KIMI_RUNTIME) {
        const kimi=await upstream(()=>kimiAgent.ready());
        console.log(`连接检查通过：iPhone → Along Host → Kimi Code Swarm (${new Date().toISOString()})`);
        return respond(res,200,{along:true,runtime,ready:true,kimi});
      }
      if (dshRunnerURL) {
        const runner=await runnerCall('/health');
        if (runner?.ready!==true) throw new HostError('云端 DSH 尚未就绪',503);
      } else {
        await upstream(()=>superAgentReady());
      }
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
      if (runtime===KIMI_RUNTIME) return respond(res,200,await upstream(()=>kimiAgent.startTask(dshInput,who.userId)));
      if (dshRunnerURL) return respond(res,200,await upstream(()=>runnerTaskStart(who.userId,dshInput)));
      return respond(res,200,await upstream(()=>superAgentCall('/along-source/api/tasks',{value:dshInput})));
    }
    if (req.method==='POST' && path==='/super-agent/tasks/status') {
      const input=await body(req),id=requestId(input?.requestId),runtime=requestedRuntime(input?.runtime);
      if (runtime===KIMI_RUNTIME) return respond(res,200,await upstream(()=>kimiAgent.taskStatus(who.userId,id)));
      if (dshRunnerURL) return respond(res,200,await upstream(()=>runnerTaskStatus(who.userId,id)));
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
      if (runtime===KIMI_RUNTIME) return respond(res,200,await upstream(()=>kimiAgent.startGoal(goalInput,who.userId)));
      if (dshRunnerURL) return respond(res,200,await upstream(()=>runnerGoalStart(who.userId,goalInput,snapshot.planning?.dailyDelegation?recipient:null)));
      const response=await upstream(()=>superAgentCall('/along-source/api/goals',{value:goalInput,contextReview:!!snapshot.planning}));
      return respond(res,200,{...response,run:await upstream(()=>normalizeGoalRun(response.run,snapshot.planning?.dailyDelegation?recipient:null))});
    }
    if (req.method==='POST' && path==='/super-agent/goals/status') {
      const input=await body(req),id=requestId(input?.requestId),runtime=requestedRuntime(input?.runtime);
      if (runtime===KIMI_RUNTIME) return respond(res,200,await upstream(()=>kimiAgent.goalStatus(who.userId,id)));
      if (dshRunnerURL) return respond(res,200,await upstream(()=>runnerGoalStatus(who.userId,id,recipient)));
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
      const raw=await runExclusive(who.userId,()=>upstream(()=>runTaskCodex(prompt)));
      const suggestion=await upstream(()=>validateTaskReply(raw,route.remaining));
      return respond(res,200,{...route,suggestion,source:'live-along'});
    }
    return respond(res,404,{error:'未找到接口'});
  } catch(error) { respond(res,statusForError(error),{error:error.message}); }
});
let lastSourceWarning=0;
const sourceEvents=createHostSourceEventBridge({journal:sourceJournal,connection:sourceConnections,bridge,endpoint:superAgentURL,
  stillBound:who=>eventIngest&&bridgeToken&&registeredUsers.has(who?.userId)&&stillPaired(who),
  onError:()=>{if(Date.now()-lastSourceWarning>60_000){lastSourceWarning=Date.now();console.warn('Along 源状态同步暂不可用，将保留待发状态稍后重试');}},
});
// 后台泵逐用户（M2）：按绑定表给每个绑定各跑一轮，用户之间互不阻塞、互不代取。
const sourceEventTimer=setInterval(()=>{
  for (const entry of pairings) sourceEvents.pump({userId:entry.user_id,deviceId:entry.device_id});
},3000);sourceEventTimer.unref();
server.listen(port,lanHost,()=>{
  console.log(`Along 服务: https://${lanHost}:${port}`);
  console.log(`证书指纹 SHA-256: ${fingerprint}`);
  console.log(`证书到期: ${certExpiry}`);
  // 通用码只在本地单用户形态打印；多用户形态发码走 host/pair-code.mjs（码不落容器日志，§3.7）。
  if (code) console.log(`一次性配对码: ${code} (15 分钟有效)`);
  console.log('仅用于可信任的同一 Wi-Fi；退出请按 Ctrl+C。');
});
server.on('close',()=>{clearInterval(sourceEventTimer);sourceEvents.close();});
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
