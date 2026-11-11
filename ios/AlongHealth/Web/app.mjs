import {KEY, loadState, setSnapshot} from './health.mjs';
import {ACTIVE_GOAL_KEY, FINANCE_KEY, ensureHealthGoal, loadFinance, connectFinanceDemo, addFinanceDemoRecord, healthView, financeView} from './workspace.mjs';
import {EXPERIMENT, startExperiment, routeHealthEvent, acceptAgentSuggestion, agentRequestPayload} from './loop.mjs';
import {goalChangeText} from './goal-agent-core.mjs';
import {AGENT_KEY, GOALS_KEY, CONVERSATIONS_KEY, readStored, agentCall, loadNativeConnection, saveNativeConnection} from './agent-client.mjs';
import {ADAPTIVE_LAYOUTS_KEY, customGoalEntries, findInitialCustomGoalCandidate, goalDomain, isCustomGoalKey, safeAdaptiveLayout, validateAdaptiveLayout} from './adaptive-ui.mjs';
import {GOAL_SUPER_AGENT_RUNS_KEY, SUPER_AGENT_RUNS_KEY, createFailedGoalSuperAgentRun, createFailedSuperAgentRun,
  createGoalSuperAgentRequest, createPendingGoalSuperAgentRun, createPendingSuperAgentRun, createSuperAgentRequest,
  safeGoalSuperAgentRun, safeSuperAgentRun, withRunError, AGENT_RUN_TIMEOUT_MS, AGENT_RUNTIME_KEY, DSH_RUNTIME, KIMI_RUNTIME, agentRuntimeLabel, safeAgentRuntime, newId} from './super-agent.mjs';
import {AGENT_NOTIFICATION_LEDGER_KEY, goalRunNotification, taskRunNotification, healthProposalNotification,
  notificationWasDelivered, recordNotificationDelivered} from './agent-notifications.mjs';
import {PLANNING_STATE_KEY,cleanDailyDelegation,validateDailyActions,agentHealthSnapshot,cleanPlanningContext,healthContextChanges,createPlanningContext,validateReassessment,buildBackgroundReviewRequest} from './contextual-planning.mjs';
const TICKET_KEY = 'along.goal-ticket.v1';
const REMINDER_SYNC_KEY='along.health-reminder-sync.v1';
const HEALTH_SHARING_KEY='along.health-sharing.v1';

const app = document.querySelector('#app');
const sheet = document.querySelector('#sheet');
const toast = document.querySelector('#toast');
// 离线缓存：只有浏览器支持时才注册（App 内的 along:// 不是安全上下文，会自动跳过）。
if ('serviceWorker' in navigator) {
  try { void navigator.serviceWorker.register('./sw.js').catch(()=>{}); }
  catch { /* 注册失败不影响正常使用。 */ }
}
let state = ensureHealthGoal(loadState(localStorage.getItem(KEY)));
// 实验是个沙盒：App 重启后不该还停在演示数据上、把用户真实的健康摘要顶掉。
// 实验室页的「返回目标」退出实验时也是这么做的，这里是重启时的同一件事。
// 备份本身也可能被写坏：形状不对就用初始状态，别让整个 App 起不来。
if (state.loop?.experiment === EXPERIMENT) {
  const backup=state.loop.previousState;
  const restored=backup && typeof backup==='object' && Array.isArray(backup.goals) ? backup : loadState(null);
  state = ensureHealthGoal(restored);
  localStorage.setItem(KEY, JSON.stringify(state));
}
let finance = loadFinance(localStorage.getItem(FINANCE_KEY));
const storedActiveGoal=localStorage.getItem(ACTIVE_GOAL_KEY);
let activeGoal = storedActiveGoal === 'finance' || isCustomGoalKey(storedActiveGoal) ? storedActiveGoal : 'health';
let screen = 'home';
let previousGoalBeforeDraft = null;
let selectedTaskId = null;
let running = false;
let agentBusy = false;
let agentConfig = readStored(AGENT_KEY, {});
let agentRuntime = safeAgentRuntime(localStorage.getItem(AGENT_RUNTIME_KEY) || KIMI_RUNTIME);
let verifiedHealthHost=false;
let checkingHealthHost=false;
let agentConnection = {status:agentConfig.token?'checking':'unconfigured',error:''};
let goalCustom = readStored(GOALS_KEY, {health:null, finance:null, custom:null});
let conversations = readStored(CONVERSATIONS_KEY, {health:[], finance:[], custom:[]});
const storedLayouts = readStored(ADAPTIVE_LAYOUTS_KEY, {health:null, finance:null, custom:null});
let goalLayouts = Object.fromEntries(Object.entries(storedLayouts).map(([key,value])=>[key,safeAdaptiveLayout(value,goalDomain(key))]));
goalLayouts={health:goalLayouts.health||null,finance:goalLayouts.finance||null,...goalLayouts};
let superAgentRuns = readStored(SUPER_AGENT_RUNS_KEY, {});
let goalSuperAgentRuns = readStored(GOAL_SUPER_AGENT_RUNS_KEY, {});
const reviews=new Map();
let nativeHealthStatus=window.AlongHealthBridge?.refresh?'checking':'available';
let nativeObservationSeen=false;
let sourceGeneration=0;
const BG_TEMPLATE_KEY='along.health-background-template.v1';
let nativeConnectionRestored=false;
let backgroundReplace=null,backgroundClaim=null,backgroundSyncQueued=false;
function persistAgentConfig(config) {
  const previous=readStored(AGENT_KEY,{});
  if (previous.token&&(previous.token!==config.token||previous.fingerprint!==config.fingerprint)) {
    for (const key of healthGoalKeys()) reviewFor(key).revokeDaily();
  }
  if (['baseURL','fingerprint','token'].some(field=>previous[field]!==config[field])) localStorage.removeItem(BG_TEMPLATE_KEY);
  localStorage.setItem(AGENT_KEY,JSON.stringify(config));
}
function currentBackgroundTemplate() {
  if (document.visibilityState==='hidden'||!nativeObservationSeen||!nativeConnectionRestored||!canGiveTaskInstruction(activeGoal)||agentRuntime!==DSH_RUNTIME||
      state.loop?.experiment===EXPERIMENT||state.snapshot.backgroundReviewAllowed!==true||state.snapshot.backgroundReviewGoalKey!==activeGoal) return null;
  try { return reviewFor(activeGoal).backgroundTemplate(); }
  catch { return undefined; } // local storage unavailable: scope cannot be verified
}
function queueBackgroundSync() {
  if (backgroundSyncQueued||!window.AlongHealthBridge?.backgroundReview) return;
  backgroundSyncQueued=true;
  queueMicrotask(()=>{backgroundSyncQueued=false;void syncBackgroundTemplate().catch(()=>{});});
}
async function syncBackgroundTemplate() {
  const bridge=window.AlongHealthBridge;
  if (!bridge?.backgroundReview||!nativeConnectionRestored||nativeHealthStatus==='checking'||
      !nativeObservationSeen&&nativeHealthStatus==='available'||document.visibilityState==='hidden') return;
  const template=currentBackgroundTemplate();
  if (template===undefined) {
    backgroundReplace=null;
    await bridge.backgroundReview('disarm',{});
    return false;
  }
  for (const review of reviews.values()) review.retireNative(template);
  if (!template) localStorage.removeItem(BG_TEMPLATE_KEY);
  const goals=template?[template]:[];
  const value=JSON.stringify(goals);
  if (backgroundReplace?.value===value) return backgroundReplace.promise;
  const entry={value};
  backgroundReplace=entry;
  // Bridge messages are enqueued in call order. A newer revocation must not wait
  // for a previous response, and its completion must never re-arm an older scope.
  entry.promise=(async()=>bridge.backgroundReview('replace',{goals}))().then(reply=>{
    if (template&&reply?.enabled!==true) throw Error('后台授权失效');
    return true;
  }).catch(async()=>{
    if (backgroundReplace===entry) {
      backgroundReplace=null;
      try { await bridge.backgroundReview('disarm',{}); } catch { /* native disarms on entering foreground */ }
    }
    return false;
  });
  return entry.promise;
}
async function claimBackgroundReview(template) {
  if (backgroundClaim?.version===template.version) return backgroundClaim.promise;
  const entry={version:template.version};
  backgroundClaim=entry;
  entry.promise=(async()=>{
    const bridge=window.AlongHealthBridge;
    const response=await bridge.backgroundReview('pending',{goalKey:template.goalKey,version:template.version});
    if (currentBackgroundTemplate()?.version!==template.version||response?.enabled!==true||!Array.isArray(response.runs)) return false;
    for (const receipt of response.runs) {
      if (receipt.goalKey!==template.goalKey||receipt.version!==template.version) continue;
      const review=reviewFor(template.goalKey);
      if (!review.claimBackground(receipt,template)) return false;
      try { await bridge.backgroundReview('ack',{goalKey:template.goalKey,version:template.version,requestId:receipt.requestId}); }
      catch { /* local request ownership is durable; acknowledgement is idempotent */ }
    }
    return true;
  })().catch(()=>false).finally(()=>{if (backgroundClaim===entry) backgroundClaim=null;});
  return entry.promise;
}

function hasHealthSource(key) {
  const types=goalCustom[key]?.healthTypes;
  if (!Array.isArray(types)) return key==='health'; // Existing imports belong to the original health workspace.
  return (key==='health'||isCustomGoalKey(key))&&types.length>0;
}
function healthGoalKeys() { return ['health',...Object.keys(goalCustom).filter(isCustomGoalKey)].filter(hasHealthSource); }
function scopedKey(base,key) { return key==='health'?base:`${base}:${key}`; }
function reviewFor(key) {
  if (!reviews.has(key)) reviews.set(key,createHealthReview(key));
  return reviews.get(key);
}
// 当前目标可能是一个还没确认的新目标（草稿）。
// - 有内容可恢复（写下的消息、没跑完的运行）：回到那一页，用户写下的东西
//   不能因为重启就再也看不见。
// - 什么都没有的草稿不是目标：回到健康目标，别让首页渲染出一个幽灵自定义目标。
// - 上次停在一个还没拿到结果的请求上：那次请求在 App 关掉时就没有下文了，
//   落成明确终态，别把用户锁在一页禁用的输入框上。
const draftKey=isCustomGoalKey(activeGoal)&&!goalCustom[activeGoal]&&!goalLayouts[activeGoal]?activeGoal:null;
if (draftKey) {
  const draftRunKey=Object.keys(goalSuperAgentRuns).find(key=>key.startsWith(`${draftKey}:`));
  const draftRun=draftRunKey?goalSuperAgentRuns[draftRunKey]:null;
  if ((conversations[draftKey]?.length||0)>0 || draftRun) {
    screen='agent';
    if (draftRun && draftRun.actual!==true && draftRun.status==='working') {
      goalSuperAgentRuns={...goalSuperAgentRuns,[draftRunKey]:{...draftRun,status:'blocked',statusLabel:'需要重发',
        error:'App 关闭时这次请求没有收到结果；要继续请再发一次。'}};
      saveGoalSuperAgentRuns();
    }
  } else {
    delete conversations[draftKey];
    saveConversations();
    activeGoal='health';
    localStorage.setItem(ACTIVE_GOAL_KEY,activeGoal);
  }
}
function syncAgentViewportHeight() {
  const height=window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--agent-viewport-height',`${Math.round(height)}px`);
}
syncAgentViewportHeight();
window.visualViewport?.addEventListener('resize',syncAgentViewportHeight);
window.addEventListener('resize',syncAgentViewportHeight);
localStorage.setItem(KEY, JSON.stringify(state));

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
// 仓库外的 Agent 服务给出的字段不保证是字符串：不能直接对它调用 .slice()，
// 那会在 render() 里抛 TypeError，整个界面停在旧页面上再也动不了。
const shortText = (value,max=8) => typeof value==='string'&&value?value.slice(0,max):'—';
// 旧版本宿主写下的记录里可能没有时间戳：Intl 格式化无效日期会抛 RangeError，
// 整个 render() 挂掉，界面停在旧页面上再也动不了。
const formatStamp = (value,options) => {
  // 宿主用 0 表示「起始时间未知」（Number(entry.createdAt)||0），
  // 那不是 1970 年：显示一个看起来很正常的时间，比显示「未知」更糟。
  if (value==null || value===0 || typeof value==='boolean') return '—';
  const date=new Date(value);
  return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',options).format(date):'—';
};
const formatDate = value => formatStamp(value,{month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'});
const formatTime = value => formatStamp(value,{hour:'2-digit', minute:'2-digit'});
function notice(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3200);
}
// The OS queue can include a dated action explicitly requested on the paired Mac.
let reminderRead=null;
function readNextGoalReminder(goalKey,force=false) {
  if (!window.AlongAgentBridge?.pendingGoalReminder||goalKey==='finance') return;
  if (!force&&reminderRead?.goalKey===goalKey&&Date.now()-reminderRead.at<60000) return;
  const read={goalKey,at:Date.now(),item:reminderRead?.goalKey===goalKey?reminderRead.item:null};
  reminderRead=read;
  Promise.resolve().then(()=>window.AlongAgentBridge.pendingGoalReminder(goalKey)).then(item=>{
    if (reminderRead!==read) return;
    read.item=item?.goalKey===goalKey&&typeof item.title==='string'&&typeof item.taskId==='string'&&Date.parse(item.scheduledFor)>Date.now()?item:null;
    if (screen==='home'&&activeGoal===goalKey) render();
  }).catch(()=>{if (reminderRead===read&&read.item) {read.item=null;if (screen==='home'&&activeGoal===goalKey) render();}});
}
function nextReminderLine() {
  const item=reminderRead?.goalKey===activeGoal?reminderRead.item:null;
  if (!item||Date.parse(item.scheduledFor)<=Date.now()) return '';
  return `<div class="next-reminder"><span>iPhone 已安排</span><strong>${esc(item.title)}</strong><time datetime="${esc(item.scheduledFor)}">${esc(formatDate(item.scheduledFor))}</time></div>`;
}
const dailyReads=new Map(), dailyJobs=new Map(), dailyCancels=new Map();
function localCalendarDay(now=new Date()) {
  return [now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');
}
const currentZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
function dailyPhoneScope(goalKey) {
  if (!hasHealthSource(goalKey)||state.source!=='healthkit'||state.loop?.experiment===EXPERIMENT||agentRuntime!==DSH_RUNTIME) return null;
  const health=scopedSnapshot(goalKey);
  return health.contextReviewAllowed?health:null;
}
function cancelDailyAgenda(goalKey) {
  dailyReads.delete(goalKey);dailyJobs.delete(goalKey);
  if (!window.AlongAgentBridge?.dailyReminderStatus) return;
  const previous=dailyCancels.get(goalKey)||Promise.resolve();
  const cancel=previous.catch(()=>{}).then(()=>window.AlongAgentBridge.notification('cancelDailyReminders',{goalKey}));
  dailyCancels.set(goalKey,cancel);
  void cancel.catch(()=>{}).finally(()=>{if (dailyCancels.get(goalKey)===cancel) dailyCancels.delete(goalKey);});
}
function readDailyAgenda(goalKey,force=false) {
  const bridge=window.AlongAgentBridge,scope=dailyPhoneScope(goalKey);
  if (!scope||!bridge?.dailyReminderStatus||document.visibilityState==='hidden'||activeGoal!==goalKey) return;
  const review=reviewFor(goalKey),plan=review.todayActions(),day=localCalendarDay(),timezone=currentZone();
  const anchor=reminderRead?.goalKey===goalKey?reminderRead.item?.requestId:null;
  const recipient=agentConfig.fingerprint;
  const signature=JSON.stringify([day,timezone,scope.selectedTypes,plan?.requestId,anchor||null,recipient,nativeHealthStatus,nativeObservationSeen,nativeConnectionRestored]);
  const old=dailyReads.get(goalKey);
  if (dailyJobs.has(goalKey)||(!force&&old?.signature===signature&&Date.now()-old.at<60000)) return;
  const job={}; dailyJobs.set(goalKey,job);
  const valid=()=>dailyJobs.get(goalKey)===job&&activeGoal===goalKey&&recipient===agentConfig.fingerprint&&localCalendarDay()===day&&currentZone()===timezone&&
    document.visibilityState!=='hidden'&&JSON.stringify(dailyPhoneScope(goalKey)?.selectedTypes)===JSON.stringify(scope.selectedTypes);
  const read={signature,at:Date.now(),day,timezone,items:old?.day===day&&old.timezone===timezone?old.items:{}};
  dailyReads.set(goalKey,read);
  void (async()=>{
    await dailyCancels.get(goalKey);if (!valid()) return;
    const readOS=async()=>{let result;try {result=await bridge.dailyReminderStatus({goalKey,localDate:day,timezone});} catch {if (valid()) read.items={};throw Error('无法读取系统通知');}
      if (valid()) {
        const confirmed=result?.goalKey===goalKey&&result?.localDate===day&&result?.timezone===timezone;
        read.items=confirmed?result.items||{}:{};read.appliedRequestId=confirmed?result.appliedRequestId:null;read.delegationId=confirmed?result.delegationId:null;
      }
    };
    await readOS();
    if (!valid()) return;
    if (!review.dailyDelegation()&&nativeConnectionRestored&&nativeObservationSeen&&nativeHealthStatus==='available'&&agentConfig.token) {
      const anchors=[...new Set([anchor,read.items.sleep?.requestId,read.items.workout?.requestId,review.state.lastDecision?.requestId].filter(Boolean))].slice(0,4);
      if (anchors.length) {
        const {grant}=await agentCall(agentConfig,'/super-agent/daily-delegation',{goalKey,anchors});
        if (valid()&&grant?.goalKey===goalKey&&grant.topics?.every(t=>scope.selectedTypes.includes(t))) {
          const run=await agentCall(agentConfig,'/super-agent/goals/status',{runtime:DSH_RUNTIME,requestId:grant.requestId,contextReview:true});
          if (valid()) await review.claimDailyDelegation(grant,run);
        }
      }
    }
    if (!valid()) return;
    const current=review.todayActions(),grant=review.dailyDelegation();
    if (nativeHealthStatus!=='available'||!nativeObservationSeen||!current||!grant||current.delegationId!==grant.id||current.localDate!==day||current.timezone!==timezone) return;
    const needs=read.appliedRequestId!==current.requestId||read.delegationId!==grant.id||grant.topics.some(topic=>{
      const expected=topic==='sleep'?current.sleepReminderAt:current.workoutReminderAt,item=read.items[topic];
      const scheduled=item?.status==='scheduled';
      if (!expected||Date.parse(expected)<=Date.now()) return scheduled&&!!item?.delegationId;
      return !scheduled||Date.parse(item.scheduledFor)!==Date.parse(expected);
    });
    if (!needs) return;
    await bridge.notification('applyDailyReminders',{goalKey,localDate:day,timezone,delegated:true,delegationId:grant.id,
      selectedTypes:scope.selectedTypes.filter(t=>grant.topics.includes(t)),requestId:current.requestId,ticketId:current.ticketId});
    if (valid()) await readOS();
  })().catch(()=>{/* A DSH suggestion remains visible even when the phone cannot confirm scheduling. */})
    .finally(()=>{if (dailyJobs.get(goalKey)===job) {dailyJobs.delete(goalKey);if (screen==='home'&&activeGoal===goalKey) render();}});
}
function nativeDailyReceipt(topic,action) {
  const read=dailyReads.get(activeGoal);
  if (read?.day!==localCalendarDay()||read.timezone!==currentZone()) return null;
  const item=read.items?.[topic],due=topic==='sleep'?action.sleepReminderAt:action.workoutReminderAt;
  if (!item||!due||!Number.isFinite(Date.parse(due))||Date.parse(item.scheduledFor)!==Date.parse(due)) return null;
  if (item.status==='scheduled'&&Date.parse(due)>Date.now()) return 'iPhone 已安排';
  if (item.status==='delivered') return '已送达通知中心';
  return null;
}
// A preserved private task is matched for local display only; never send its text
// to DSH. Ambiguous matches get a distinct daily row rather than a wrong join.
function dailyTopicTaskIds(layout,weekly) {
  const ids={};
  for (const topic of ['sleep','workout']) {
    const candidates=(layout?.tasks||[]).filter(t=>!(t.kind==='reminder'&&t.scheduledFor)&&
      !/记录|回顾|统计|复盘|测量|评估/.test(t.title)&&
      (topic==='sleep'?/睡眠|入睡|就寝|睡觉|睡前|早睡/.test(t.title):/运动|锻炼|散步|快走|步行|训练/.test(t.title))&&
      !(topic==='sleep'?/运动|锻炼|散步|训练/:/睡眠|入睡|就寝|睡觉/).test(t.title));
    if (topic==='workout'&&weekly) ids[topic]=weekly.id;
    else if (candidates.length===1) ids[topic]=candidates[0].id;
  }
  return ids;
}
function dayPresentation(topic,action,legacy) {
  if (!action||topic==='sleep'&&!action.sleepReminderAt&&!action.bedtimeAt) {
    if (!legacy||topic!=='sleep') return null;
    return {title:formatTime(legacy.scheduledFor)+' 提醒准备睡觉',status:'iPhone 已安排',sub:'',date:localCalendarDay()};
  }
  const due=topic==='sleep'?action.sleepReminderAt:action.workoutReminderAt;
  const minutes=action.workoutMinutes,bed=action.bedtimeAt;
  if (topic==='sleep'&&!due&&!bed||topic==='workout'&&minutes==null) return null;
  const clock=t=>formatTime(t);
  const bedtime=bed?(localCalendarDay(new Date(bed))===action.localDate?'今晚':'次日')+' '+clock(bed)+' 建议就寝':'';
  const title=topic==='sleep'?(due?clock(due)+' 提醒准备睡觉':bedtime):
    minutes===0?'今天休息，不安排运动':'今天建议运动 '+minutes+' 分钟';
  const status=nativeDailyReceipt(topic,action);
  const sub=[topic==='sleep'&&due?bedtime:'',topic==='workout'&&due?clock(due)+' '+(minutes===0?'休息提醒':'运动提醒'):'',
    due&&!status?(Date.parse(due)>Date.now()?'手机排程待确认':'未确认送达'):''].filter(Boolean).join(' · ');
  return {title,status:status||'DSH 已规划',sub,date:action.localDate,source:true};
}

const notificationAttempts=new Set();
async function enableAgentNotifications() {
  if (!window.AlongAgentBridge?.notification) return;
  try { await window.AlongAgentBridge.notification('enable'); }
  catch { /* 通知权限不阻塞 Agent 编排。 */ }
}
async function deliverAgentNotification(payload) {
  if (!payload || !window.AlongAgentBridge?.notification || notificationAttempts.has(payload.id)) return;
  const saved=localStorage.getItem(AGENT_NOTIFICATION_LEDGER_KEY);
  if (notificationWasDelivered(saved,payload.id)) return;
  notificationAttempts.add(payload.id);
  try {
    const result=await window.AlongAgentBridge.notification('notify',payload);
    if (result?.scheduled) localStorage.setItem(AGENT_NOTIFICATION_LEDGER_KEY,recordNotificationDelivered(localStorage.getItem(AGENT_NOTIFICATION_LEDGER_KEY),payload.id));
  } catch {
    // 用户拒绝通知或系统暂时不可用时，任务结果仍保留在 Along 里。
  } finally { notificationAttempts.delete(payload.id); }
}
// Serialize replacements. A plan adopted while the OS is scheduling the last
// one is replayed afterwards. Persist the intent until the native call succeeds.
const syncingHealthReminders=new Set();
function replaceHealthReminders(requestId,goalKey,clear=false) {
  if (!window.AlongAgentBridge?.notification) return;
  localStorage.setItem(scopedKey(REMINDER_SYNC_KEY,goalKey),JSON.stringify({requestId,clear}));
  void syncHealthReminders(goalKey);
}
async function syncHealthReminders(goalKey) {
  const syncKey=scopedKey(REMINDER_SYNC_KEY,goalKey);
  const sync=readStored(syncKey,null);
  if (!sync||syncingHealthReminders.has(goalKey)||!window.AlongAgentBridge?.notification) return;
  syncingHealthReminders.add(goalKey);
  try {
    const tasks=sync.clear?[]:(goalLayouts[goalKey]?.tasks||[]);
    const items=tasks.filter(t=>t.kind==='reminder'&&Date.parse(t.scheduledFor)>Date.now())
      .map(t=>({goalKey,id:t.id,taskId:t.id,title:t.title,body:t.detail,scheduledFor:t.scheduledFor,requestId:sync.requestId}));
    const reply=await window.AlongAgentBridge.notification('replaceHealthReminders',{goalKey,items});
    readNextGoalReminder(goalKey,true);
    if (!Number.isInteger(reply?.scheduledCount)||reply.scheduledCount!==items.length) throw Error('请检查 Along 的系统通知权限');
    if (readStored(syncKey,null)?.requestId===sync.requestId) localStorage.removeItem(syncKey);
  } catch(error) {
    if (readStored(syncKey,null)?.requestId===sync.requestId)
      localStorage.setItem(syncKey,JSON.stringify({...sync,error:error.message}));
  } finally {
    syncingHealthReminders.delete(goalKey);
    const next=readStored(syncKey,null);
    if (next&&next.requestId!==sync.requestId) void syncHealthReminders(goalKey);
    if (screen==='home') render();
  }
}
async function refreshAgentConnection({healthOnly=false}={}) {
  if (healthOnly&&checkingHealthHost) return;
  const config=agentConfig,runtime=agentRuntime;
  if (healthOnly) checkingHealthHost=true;
  if (!agentConfig.token) {checkingHealthHost=false;verifiedHealthHost=false;agentConnection={status:'unconfigured',error:''};return;}
  if (!healthOnly) {agentConnection={status:'checking',error:''};if (screen==='agent') renderAgentUpdate();}
  try {
    const status=await agentCall(config,'/connection/status',{runtime});
    if (agentConfig!==config||agentRuntime!==runtime) return;
    if (!status?.along || !status?.ready || status.runtime!==agentRuntime) throw Error(`${agentRuntimeLabel(agentRuntime)} 尚未就绪`);
    verifiedHealthHost=true;
    agentConnection={status:'ready',error:''};
    for (const key of healthGoalKeys()) {
      const review=reviewFor(key);
      if (review.canRecoverConnection()) void review.reviewHealthContext('reconnect');
    }
    if (healthOnly) return;
    const failedRun=currentGoalSuperAgentRun(activeGoal);
    if (failedRun?.status==='blocked' && failedRun.actual!==true) {
      const key=goalRunKey(activeGoal);
      const legacyKey=activeGoal;
      const legacyRun=goalSuperAgentRuns[legacyKey];
      const {[key]:_discarded,...remainingRuns}=goalSuperAgentRuns;
      const {[legacyKey]:_legacyDiscarded,...cleanRuns}=remainingRuns;
      // 旧键里存着的也是一条过不了白名单的坏记录时一起清掉：
      // 只清新键的话，那条坏记录会一直挂在存储里，用户每次打开都撞上它。
      goalSuperAgentRuns=legacyRun&&!safeGoalSuperAgentRun(legacyRun)?cleanRuns:remainingRuns;
      saveGoalSuperAgentRuns();
    }
    const history=conversations[activeGoal]||[];
    const cleaned=history.filter(item=>!(item.role==='assistant' && /^这次没有完成：目标输入已迁移到 DSH Super Agent/.test(item.text)));
    if (cleaned.length!==history.length) {
      conversations[activeGoal]=cleaned;
      saveConversations();
    }
  } catch(error) {
    if (agentConfig!==config||agentRuntime!==runtime) return;
    verifiedHealthHost=false;
    agentConnection={status:'error',error:error.message||'连接检查失败'};
  } finally { if (healthOnly) checkingHealthHost=false; }
  if (screen==='agent') renderAgentUpdate();
}
function saveHealth(next) {
  const source=state.loop?.experiment===EXPERIMENT?state.loop.previousState:state;
  const previous=source?.source==='healthkit'?source.snapshot:null;
  const before=agentHealthSnapshot(previous),after=agentHealthSnapshot(next.source==='healthkit'?next.snapshot:null);
  const inExperiment=next.loop?.experiment===EXPERIMENT&&next.loop.previousState?.source==='healthkit';
  const historyReduced=before.comparisonHistoryAllowed===true&&after.comparisonHistoryAllowed!==true;
  if (!inExperiment&&(historyReduced||(before.contextReviewAllowed&&!after.contextReviewAllowed)||before.selectedTypes.some(t=>!after.selectedTypes.includes(t)))) {
    for (const key of healthGoalKeys()) {
      const allowed=goalCustom[key]?.healthTypes;
      if (!allowed||historyReduced&&goalCustom[key]?.comparisonHistoryAllowed||before.contextReviewAllowed&&!after.contextReviewAllowed||
          before.selectedTypes.some(t=>!after.selectedTypes.includes(t)&&allowed.includes(t))) {
        reviewFor(key).restrict();
        if (Array.isArray(allowed)) {
          goalCustom[key]={...goalCustom[key],healthTypes:allowed.filter(type=>after.selectedTypes.includes(type)),
            comparisonHistoryAllowed:goalCustom[key].comparisonHistoryAllowed===true&&after.comparisonHistoryAllowed===true};
          saveGoalCustom();
        }
      }
    }
  }
  state = ensureHealthGoal(next);
  localStorage.setItem(KEY, JSON.stringify(state));
  if (screen !== 'agent') render();
}
function saveFinance(next) {
  finance = next;
  localStorage.setItem(FINANCE_KEY, JSON.stringify(finance));
  render();
}
function show(html) {
  sheet.innerHTML = html;
  sheet.showModal();
}

function brand() {
  return `<div class="brand"><img class="brand-symbol" src="./app-icon.png" alt=""><span>along</span></div>`;
}
function backButton(action,label) {
  return `<button class="back-button icon-only" data-action="${esc(action)}" aria-label="${esc(label)}" title="${esc(label)}"><svg viewBox="0 0 12 24" aria-hidden="true"><path d="M9 18l-6-6 6-6"/></svg></button>`;
}
function customView(goalKey=activeGoal) {
  return {
    id:'custom',category:'个人目标',title:goalCustom[goalKey]?.title || '定义一个真正属于你的目标',measure:'—',measureUnit:'',percent:0,
    progressText:'先把想实现的改变告诉 Along',note:'Along 会整理目标、待确认信息和动态任务；采用后才更新首页。',
    primary:{title:'从一句话开始',detail:'可以包含期限、偏好、限制、已知条件和你不希望发生的事情。',status:'待定义'},secondary:[],connection:null,
  };
}
const taskStateLabel={temporary:'进行中',planned:'已规划',deferred:'到时生成'};
const agentStateLabel={queued:'等待',working:'工作中',done:'已完成',blocked:'需处理'};
// 运行状态与进度会进 class 和 style：只认白名单里的值，Agent 的原样字符串不许进 HTML。
const RUN_STATUSES=new Set(['done','working','blocked']);
const AGENT_STATUSES=new Set(['queued','working','done','blocked']);
function runStatus(value) { return RUN_STATUSES.has(value)?value:''; }
function runProgress(value) { const n=Number(value); return Number.isFinite(n)?Math.max(0,Math.min(100,n)):0; }
function runtimeMeta(runtime=agentRuntime) {
  return safeAgentRuntime(runtime)===KIMI_RUNTIME
    ? {short:'Kimi Swarm',full:'Kimi Code Agent Swarm',main:'Kimi Main Session',worker:'Subagents',description:'Main Session 启动真实 Swarm，并行子 Agent 拆解、复核并生成动态任务。'}
    : {short:'DSH Agents',full:'DSH Super Agent',main:'DSH Main Session',worker:'Worker',description:'Main Session 接单，Worker 与真实子 Agent 拆解、分工并生成动态任务。'};
}
function currentTaskRecords(goalKey=activeGoal) {
  const layout=goalLayouts[goalKey];
  if (layout) return layout.tasks;
  const model=goalKey==='finance'?financeView(finance,goalCustom.finance):isCustomGoalKey(goalKey)?customView(goalKey):healthView(localHealthViewState(),goalCustom.health);
  const normalize=(task,id,index)=>({
    id,
    when:index===0?(task.status || '现在'):(task.status || '之后'),
    title:task.title,
    detail:task.detail,
    state:index===0?'planned':'deferred',
  });
  return [normalize(model.primary,'primary',0),...model.secondary.map((task,index)=>normalize(task,`follow-up-${index}`,index+1))];
}
function saveSuperAgentRuns() { localStorage.setItem(SUPER_AGENT_RUNS_KEY,JSON.stringify(superAgentRuns)); }
function runKey(taskId,runtime=agentRuntime) { return `${activeGoal}:${runtime}:${taskId}`; }
function selectedTask() { return currentTaskRecords().find(task=>task.id===selectedTaskId) || null; }
const superAgentRequests=new Set();
function taskRequest(task) { return {...createSuperAgentRequest({task:activeGoal==='finance'?task:reviewFor(activeGoal).shareableHealthTask(task),domain:goalDomain(activeGoal),goal:agentGoal(activeGoal),context:currentSummary()}),runtime:agentRuntime}; }
function localOnlyTask(task,goalKey=activeGoal) {
  return goalKey!=='finance' && reviewFor(goalKey).sharing.tasks?.some(saved=>saved.id===task.id && saved.localText);
}
function taskScope(goalKey) { return goalKey==='finance'?0:reviewFor(goalKey).sharing.scope||0; }
function taskCallKey(task,goalKey=activeGoal,runtime=agentRuntime) {
  return JSON.stringify([goalKey,runtime,taskScope(goalKey),task.id,task.title,task.detail,task.when,task.state]);
}
function taskCallIsCurrent(taskId,goalKey,runtime,callKey) {
  const task=currentTaskRecords(goalKey).find(item=>item.id===taskId);
  return task && !localOnlyTask(task,goalKey) && taskCallKey(task,goalKey,runtime)===callKey;
}
function currentSuperAgentRun(task) {
  if (localOnlyTask(task)) return null;
  const stored=superAgentRuns[runKey(task.id)];
  const legacy=agentRuntime===DSH_RUNTIME?superAgentRuns[`${activeGoal}:${task.id}`]:null;
  // The same task card can survive a rewritten task or an authorization alias change.
  const request=taskRequest(task);
  const records=[stored,legacy].filter(value=>{
    if (!value || (value.runtime && value.runtime!==agentRuntime)) return false;
    if (value.taskScope!=null && value.taskScope!==taskScope(activeGoal)) return false;
    if (typeof value.requestId==='string' && value.requestId.startsWith('along-') && value.requestId!==request.requestId) return false;
    if (request.task.id!==task.id && value.requestId!==request.requestId && value.task?.id!==request.task.id) return false;
    return ['id','title','detail','when','state'].every(field=>value.task?.[field]==null || value.task[field]===request.task[field]);
  });
  const saved=records.map(safeSuperAgentRun).find(Boolean);
  if (saved) return saved;
  const untrusted=records[0];
  return untrusted?createFailedSuperAgentRun(taskRequest(task),typeof untrusted.error==='string'&&untrusted.error?untrusted.error:'宿主返回了无法识别的运行记录',Date.now(),agentRuntime):null;
}
function stoppedTaskDecision(run) {
  return !run.ticket && ['ignore','unavailable','stop'].includes(run.eval?.decision);
}
function storeTaskReply(key,goalKey,task,run,startedAt,scope) {
  superAgentRuns={...superAgentRuns,[key]:{...run,taskScope:scope,createdAt:Number.isFinite(run.createdAt)?run.createdAt:startedAt}};
  const saved=safeSuperAgentRun(run);
  if (saved?.actual===true) void deliverAgentNotification(taskRunNotification(goalKey,task,saved));
}
async function submitSuperAgentTask(task,{retry=false}={}) {
  const goalKey=activeGoal,key=runKey(task.id),callKey=taskCallKey(task);
  if (localOnlyTask(task,goalKey)||!agentConfig.token||superAgentRequests.has(callKey)) return;
  const current=currentSuperAgentRun(task);
  if (current?.actual===true || (current?.error&&!retry)) return;
  const request=taskRequest(task),startedAt=Date.now();
  superAgentRequests.add(callKey);
  superAgentRuns={...superAgentRuns,[key]:{...createPendingSuperAgentRun(request,startedAt,request.runtime),taskScope:taskScope(goalKey)}};
  saveSuperAgentRuns();
  render();
  void enableAgentNotifications();
  try {
    const response=await agentCall(agentConfig,'/super-agent/tasks',request);
    if (!taskCallIsCurrent(task.id,goalKey,request.runtime,callKey)) return;
    const run=response?.run;
    if (run?.actual!==true || run.runtime!==request.runtime || run.requestId!==request.requestId)
      throw Error(typeof run?.error==='string'&&run.error||'Mac 没有返回与本次任务匹配的运行记录');
    storeTaskReply(key,goalKey,task,{...run,task:request.task},startedAt,taskScope(goalKey));
  } catch(error) {
    if (taskCallIsCurrent(task.id,goalKey,request.runtime,callKey))
      superAgentRuns={...superAgentRuns,[key]:{...createFailedSuperAgentRun(request,error.message,Date.now(),request.runtime),taskScope:taskScope(goalKey)}};
  } finally {
    superAgentRequests.delete(callKey);saveSuperAgentRuns();
    if (screen==='task'&&activeGoal===goalKey&&agentRuntime===request.runtime&&selectedTaskId===task.id) render();
  }
}
async function refreshSuperAgentTask(task,{retry=false}={}) {
  const goalKey=activeGoal,key=runKey(task.id),callKey=taskCallKey(task);
  if (localOnlyTask(task,goalKey)||!agentConfig.token||superAgentRequests.has(callKey)) return;
  const current=currentSuperAgentRun(task);
  if (!current?.actual || stoppedTaskDecision(current) || (current.status!=='working' && !(retry&&current.refreshFailed))) return;
  superAgentRequests.add(callKey);
  try {
    const run=await agentCall(agentConfig,'/super-agent/tasks/status',{requestId:current.requestId,runtime:current.runtime});
    if (!taskCallIsCurrent(task.id,goalKey,current.runtime,callKey)) return;
    if (run?.actual!==true || run.runtime!==current.runtime || run.requestId!==current.requestId)
      throw Error(typeof run?.error==='string'&&run.error||'Mac 没有返回与本次任务匹配的运行记录');
    if (!safeSuperAgentRun(run)) throw Error(typeof run.error==='string'&&run.error||'Mac 返回了无法识别的任务状态');
    storeTaskReply(key,goalKey,task,{...run,task:current.task??run.task},Number.isFinite(current.createdAt)?current.createdAt:Date.now(),taskScope(goalKey));
  } catch(error) {
    if (taskCallIsCurrent(task.id,goalKey,current.runtime,callKey))
      superAgentRuns={...superAgentRuns,[key]:{...withRunError({...current,createdAt:Number.isFinite(current.createdAt)?current.createdAt:Date.now()},error.message),refreshFailed:true}};
  } finally {
    superAgentRequests.delete(callKey);saveSuperAgentRuns();
    if (screen==='task'&&activeGoal===goalKey&&agentRuntime===current.runtime&&selectedTaskId===task.id) render();
  }
}
function saveGoalSuperAgentRuns() { localStorage.setItem(GOAL_SUPER_AGENT_RUNS_KEY,JSON.stringify(goalSuperAgentRuns)); }
function goalRunKey(goalKey=activeGoal,runtime=agentRuntime) { return `${goalKey}:${runtime}`; }
function currentGoalSuperAgentRun(goalKey=activeGoal) {
  const key=goalRunKey(goalKey);
  const stored=goalSuperAgentRuns[key];
  // 旧版本的记录存在不带运行时前缀的键里，两边都要一样处理。
  const legacy=agentRuntime===DSH_RUNTIME?goalSuperAgentRuns[goalKey]:null;
  const saved=safeGoalSuperAgentRun(stored)||safeGoalSuperAgentRun(legacy);
  if (saved) return saved;
  // 存着的记录过不了白名单：那是宿主返回了我们不认的形状。
  // 不能静默地当成「没有记录」——那样整个编排面板会消失，
  // 宿主给的原因用户永远看不到。
  const untrusted=stored??legacy;
  if (untrusted) return createFailedGoalSuperAgentRun(untrustedGoalRequest(goalKey,untrusted),untrustedGoalReason(untrusted),Date.now(),agentRuntime);
  return null;
}
// 存着的记录不可信时，要给它一个能落到失败状态的形状：还能用的部分捡回来，
// 剩下的用当前目标补齐——失败卡片要能说清「是谁、为什么」。
function untrustedGoalRequest(goalKey,value) {
  const input=value&&typeof value==='object'&&value.input&&typeof value.input==='object'?value.input:null;
  const goal=currentGoal();
  return {
    requestId:typeof value?.requestId==='string'&&value.requestId?value.requestId:newId('req'),
    goal:input?.goal&&typeof input.goal==='object'?input.goal:{domain:goalDomain(goalKey),title:goal.title,target:goal.target},
    message:typeof input?.message==='string'?input.message:'',
  };
}
const untrustedGoalReason = value => typeof value?.error==='string'&&value.error?value.error:'宿主返回了无法识别的目标编排记录';
const goalSuperAgentRequests=new Set();
function saveGoalRun(goalKey,run) {
  goalSuperAgentRuns={...goalSuperAgentRuns,[goalRunKey(goalKey,run?.runtime||agentRuntime)]:run};
  saveGoalSuperAgentRuns();
}
function applyGoalRun(goalKey,value) {
  let run=safeGoalSuperAgentRun(value);
  if (!run) throw Error(`${agentRuntimeLabel(agentRuntime)} 没有返回真实目标编排记录`);
  void deliverAgentNotification(goalRunNotification(goalKey,run));
  if (run.status==='done' && run.result && !run.applied) {
    const history=conversations[goalKey]||[];
    if (!history.some(item=>item.requestId===run.requestId)) {
      const localOnly=goalKey!=='finance'&&reviewFor(goalKey).sharing.oldRuns?.includes(run.requestId);
      const pending=currentGoalSuperAgentRun(goalKey);
      conversations[goalKey]=[...history,{role:'assistant',text:run.result.reply,proposal:localOnly?null:run.result.proposal,layout:localOnly?null:run.result.layout,
        ...(localOnly?{localOnly:true}:{}),...(pending?.requestId===run.requestId?{userIntent:pending.input?.message}:{}),
        requestId:run.requestId}].slice(-20);
      const candidate=goalDomain(goalKey)==='custom'
        ? findInitialCustomGoalCandidate(conversations[goalKey],goalCustom[goalKey],goalLayouts[goalKey])
        : null;
      if (candidate?.index===conversations[goalKey].length-1) {
        applyGeneratedGoal(goalKey,candidate.item);
        conversations[goalKey][candidate.index]={...candidate.item,proposal:null,layout:null};
        activeGoal=goalKey;
        localStorage.setItem(ACTIVE_GOAL_KEY,activeGoal);
        previousGoalBeforeDraft=null;
        if (screen==='agent') screen='home';
        notice('新目标和动态任务已创建');
      }
      saveConversations();
    }
    run={...run,applied:true};
  }
  saveGoalRun(goalKey,run);
  return run;
}
async function submitSuperAgentGoal(goalKey,message,history) {
  const request={...createGoalSuperAgentRequest({domain:goalDomain(goalKey),goal:agentGoal(goalKey),snapshot:currentSummary(),message,history}),runtime:agentRuntime};
  saveGoalRun(goalKey,createPendingGoalSuperAgentRun(request,Date.now(),agentRuntime));
  goalSuperAgentRequests.add(request.requestId);
  try {
    const response=await agentCall(agentConfig,'/super-agent/goals',request);
    if (!response?.run?.actual) throw Error(`${agentRuntimeLabel(agentRuntime)} 没有返回真实目标编排记录`);
    applyGoalRun(goalKey,response.run);
  } catch(error) {
    saveGoalRun(goalKey,createFailedGoalSuperAgentRun(request,error.message,Date.now(),request.runtime));
    throw error;
  } finally { goalSuperAgentRequests.delete(request.requestId); }
}
async function refreshSuperAgentGoal(goalKey=activeGoal) {
  const current=currentGoalSuperAgentRun(goalKey);
  if (!current?.actual || current.status!=='working' || goalSuperAgentRequests.has(current.requestId) || !agentConfig.token) return;
  goalSuperAgentRequests.add(current.requestId);
  try {
    const run=await agentCall(agentConfig,'/super-agent/goals/status',{requestId:current.requestId,runtime:current.runtime});
    applyGoalRun(goalKey,run);
    if (screen==='agent'&&activeGoal===goalKey) renderAgentUpdate();
    else if (screen==='home'&&activeGoal===goalKey) render();
  } catch(error) {
    saveGoalRun(goalKey,withRunError(current,error.message));
    // 读不到状态也要让用户看见：否则错误只存在存储里，界面一直转圈。
    if (screen==='agent'&&activeGoal===goalKey) renderAgentUpdate();
    else if (screen==='home'&&activeGoal===goalKey) render();
  } finally { goalSuperAgentRequests.delete(current.requestId); }
}
function trustedMetric(source) {
  if (activeGoal==='finance') return source==='saved' && finance.connected ? finance.saved : null;
  if (isCustomGoalKey(activeGoal)||!hasHealthSource('health')) return null;
  const selected=localHealthViewState().snapshot?.selectedTypes;
  const type={workoutMinutes:'workout',sleepMinutes:'sleep',weightKg:'weight'}[source];
  if (!state.snapshot || (state.source==='healthkit' && Array.isArray(selected) && !selected.includes(type))) return null;
  const value=state.snapshot[source];
  return Number.isFinite(value)?value:null;
}
// 目标数值是唯一事实：布局里的指标目标只是它的一份快照，必须跟着当前目标走，
// 否则目标改成 180、布局还停在 120 时，进度会在没达成时显示 100%。
function metricTarget(module) {
  const goal=currentGoal();
  const ownSource=goal.domain==='health'?'workoutMinutes':goal.domain==='finance'?'saved':null;
  if (ownSource&&module.source===ownSource&&Number.isFinite(goal.target)) return goal.target;
  return module.target;
}
function adaptiveModule(module, compact=true) {
  if (module.kind==='summary') return `<div class="adaptive-module"><span class="module-title">${esc(module.title)}</span><p>${esc(module.content)}</p></div>`;
  if (module.kind==='fact_list') {
    const items=compact?module.items.slice(0,2):module.items;
    return `<div class="adaptive-module"><span class="module-title">${esc(module.title)}</span><div class="adaptive-facts">${items.map(item=>`<div><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong></div>`).join('')}</div>${compact&&module.items.length>items.length?`<p class="module-more">另有 ${module.items.length-items.length} 项已收起</p>`:''}</div>`;
  }
  if (module.kind==='chips') return `<div class="adaptive-module"><span class="module-title">${esc(module.title)}</span><div class="adaptive-chips">${module.items.map(item=>`<span>${esc(item)}</span>`).join('')}</div></div>`;
  const value=trustedMetric(module.source), target=metricTarget(module), numericTarget=typeof target==='number'?target:null;
  const percent=value!=null&&numericTarget?Math.min(100,Math.max(0,Math.round(value/numericTarget*100))):0;
  return `<div class="adaptive-module adaptive-metric"><span class="module-title">${esc(module.title)}</span><div class="metric-value"><strong>${value==null?'—':esc(value)}</strong><span>/ ${esc(target)} ${esc(module.unit)}</span></div>${numericTarget?`<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>`:''}</div>`;
}
function adaptiveGoalCard(layout) {
  const context=layout.modules.find(module=>module.kind==='chips') || layout.modules.find(module=>module.kind==='fact_list') || layout.modules.find(module=>module.kind==='summary');
  const metric=layout.modules.find(module=>module.kind==='metric');
  const visible=[context,metric].filter(Boolean),visibleIds=new Set(visible.map(module=>module.id));
  const more=layout.modules.filter(module=>!visibleIds.has(module.id));
  return `<section class="goal-card adaptive-goal" aria-label="Along 生成的目标空间"><h1>${esc(layout.title)}</h1><p class="adaptive-summary">${esc(layout.summary)}</p>${visible.map(module=>adaptiveModule(module,true)).join('')}${more.length?`<details class="adaptive-more"><summary>查看目标详情 · ${more.length} 个模块</summary>${more.map(module=>adaptiveModule(module,false)).join('')}</details>`:''}<div class="card-actions"><button class="agent-action" data-action="edit-goal">编辑目标</button></div></section>`;
}
// Native updates re-render the home screen while a disclosure may be in use.
function homeDisclosure(name) {
  const key=activeGoal+'/'+name;
  const open=Array.from(app.querySelectorAll('details[data-home-detail][open]')).some(item=>item.dataset.homeDetail===key);
  return `data-home-detail="${esc(key)}"${open?' open':''}`;
}
function healthReviewDetails() {
  if (!hasHealthSource(activeGoal)) return '';
  const review=reviewFor(activeGoal);
  const last=review.latestDecision(),access=review.accessOptions().length>0;
  if (!last&&!access) return '';
  const label={keep:'保留当前安排',revise:'建议调整任务',need_data:'需要补充信息'}[last?.decision];
  return `<details class="health-review" ${homeDisclosure('review')}><summary><span>${last?`最近评估 · ${esc(label)}`:'评估设置'}</span>${last?`<time datetime="${esc(last.at)}">${esc(formatDate(last.at))}</time>`:''}</summary>
    ${last?`<p>${esc(last.reply||last.reason)}</p><small>${esc(agentRuntimeLabel(last.runtime))}</small>`:''}
    ${access?'<button class="minor-action" data-action="review-access">选择评估内容</button>':''}</details>`;
}
function taskProposalCard() {
  if (!hasHealthSource(activeGoal)) return '';
  const review=reviewFor(activeGoal),pendingTask=review.ticket,planningState=review.state;
  if (!pendingTask||pendingTask.requestId) {
    let message='',action='',label='';
    if (nativeHealthStatus==='unlinked'||(!state.source&&window.AlongHealthBridge?.connect)) {
      message='当前没有可用于评估的 Apple Health 数据。连接后会按最新摘要复查已有安排。';
      action='connect-health';label='连接 Apple Health';
    } else if (state.source==='healthkit'&&!state.snapshot?.contextReviewAllowed) {
      message='已保存的健康摘要目前仅用于查看。确认后，Along 会复查当前任务。';
      action='connect-health';label='启用任务评估';
    } else if (nativeHealthStatus==='unavailable') {
      message='暂时读不到新的健康摘要，已有安排仍保存在这里。';
      action='refresh-health';label='重新读取';
    } else if (state.source==='healthkit'&&!agentConfig.token) {
      message='已收到健康摘要，连接 Mac 上的 Along 后即可评估当前任务。';
      action='edit-goal';label='连接 Along';
    }
    if (action) return `<div class="task-proposal"><p>${esc(message)}</p><button class="button" data-action="${action}">${label}</button></div>`;
  }
  if (!pendingTask) return '';
  const suggestion=pendingTask.suggestion;
  // 没有建议时也要给「保留原任务」：否则这条提示会一直留在首页，
  // 用户唯一的出路是「清除本机健康摘要」，那会连他的数据一起删掉。
  const dismiss='<button class="button secondary" data-action="dismiss-task">保留原任务</button>';
  const retry=pendingTask.requestId===planningState.request?.requestId&&planningState.run?.status==='blocked';
  const needData=pendingTask.assessment?.decision==='need_data';
  if (pendingTask.status==='assigned'&&planningState.run?.status==='working'&&
      pendingTask.requestId===planningState.request?.requestId&&!suggestion&&!pendingTask.assessment&&!pendingTask.error&&!planningState.run.error) {
    return '<div class="review-in-progress"><span role="status">正在评估当前任务</span><button class="minor-action" data-action="dismiss-task">保留原任务</button></div>';
  }
  const label=suggestion?'计划调整建议':retry?'评估未完成':needData?'需要补充信息':'正在评估';
  const changes=pendingTask.assessment?.changes?.filter(c=>c.operation!=='keep')||[];
  const diff=changes.map(change=>{
    const before=review.localHealthPlan().tasks.find(t=>t.id===change.taskId);
    const after=pendingTask.layout?.tasks.find(t=>t.id===change.taskId);
    const line=t=>t?[t.scheduledFor?formatDate(t.scheduledFor):t.when,t.title,t.detail].filter(Boolean).join(' · '):'';
    const detail=change.operation==='cancel'?`取消 ${line(before)}`:change.operation==='add'?`新增 ${line(after)}`:`${line(before)} → ${line(after)}`;
    return `<li>${esc(detail)}<p>${esc(change.reason)}</p></li>`;
  }).join('');
  const actions=suggestion?`<strong>${esc(suggestion.task)}</strong>${diff?`<details><summary>查看 ${changes.length} 项调整</summary><ul>${diff}</ul></details>`:`<p>${esc(suggestion.reason)}</p>`}<button class="button" data-action="accept-task">${pendingTask.layout?'采用调整后的安排':'采用这一步'}</button>`:
    `<p>${esc(pendingTask.error||planningState.run?.error||'Along 正在规划下一步…')}</p>${retry?'<button class="button" data-action="retry-health-review">重试评估</button>':needData?'<form id="health-review-answer" class="agent-composer"><textarea name="answer" rows="2" maxlength="300" required aria-label="补充信息" placeholder="回复 Agent 的问题"></textarea><button class="button">提交回复</button></form>':''}`;
  return `<div class="task-proposal"><span>情境变化 · ${label}</span><p>${esc(pendingTask.reason)}</p>${actions} ${dismiss}</div>`;
}
// This joins private task text to Apple Health for display only. The accepted
// layout and the separately scoped plan sent to the Agent stay independent.
function localWeeklyWorkoutProgress(layout) {
  if (activeGoal!=='health'||state.source!=='healthkit') return null;
  const snapshot=scopedSnapshot(activeGoal);
  if (!snapshot.contextReviewAllowed||!snapshot.selectedTypes.includes('workout')) return null;
  const minutes=snapshot.workoutMinutes;
  const target=reviewFor(activeGoal).workoutTarget(true,{});
  if (minutes==null||target==null) return null;
  const start=new Date();
  start.setHours(0,0,0,0);
  start.setDate(start.getDate()-(start.getDay()+6)%7);
  const captured=Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(captured)||captured<start.getTime()) return null;
  const matches=layout.tasks.filter(task=>{
    if (/单次|每次|每天|每日|查看|回顾|复盘|评估|统计|记录|整理|检查/.test(task.title)) return false;
    const cadence=/本周|每周|每星期|每礼拜|这周/;
    const weekly=cadence.test(task.title)||cadence.test(task.when)||cadence.test(task.detail);
    if (!weekly||!/累计|总计|目标|至少|每周(?:运动|锻炼|训练)/.test(task.title)) return false;
    const text=cadence.test(task.title)?task.title:'每周'+task.title;
    const evidence=weeklyExerciseEvidence(text);
    return !evidence.ambiguous&&evidence.values.length===1&&evidence.values[0]===target;
  });
  if (matches.length!==1) return null;
  const remaining=minutes<target?`还差 ${target-minutes} 分钟`:'本周已达目标';
  const lines=[];
  const pair=snapshot.recentHistory?.workout;
  if (pair&&Date.now()-Date.parse(pair.recent.endAt)<26*3_600_000) {
    const date=stamp=>formatStamp(stamp,{month:'numeric',day:'numeric'});
    for (const [label,period] of [['最近完整 7 天',pair.recent],['此前 7 天',pair.previous]]) {
      const range=`${date(period.startAt)} 至 ${date(Date.parse(period.endAt)-1)}`;
      const observed=period.value==null?'无运动记录':`${period.value} 分钟 · ${period.daysWithData} 天有记录`;
      lines.push(`${label}（${range}）${observed}`);
    }
    if (pair.recent.value!=null&&pair.previous.value!=null) {
      const delta=pair.recent.value-pair.previous.value;
      lines.push(delta===0?'两期记录的运动时长相同':`最近一期记录的运动时长${delta>0?'多':'少'} ${Math.abs(delta)} 分钟`);
    }
  }
  return {id:matches[0].id,minutes,target,remaining,history:lines};
}
function dailyCardContext(layout,weekly) {
  const scope=dailyPhoneScope(activeGoal),review=scope?reviewFor(activeGoal):null,agenda=review?.todayActions(),grant=review?.dailyDelegation();
  const ids=dailyTopicTaskIds(layout,weekly);
  const item=reminderRead?.goalKey===activeGoal?reminderRead.item:null;
  const localSleep=scope?.selectedTypes.includes('sleep')&&ids.sleep&&item&&
    localCalendarDay(new Date(item.scheduledFor))===localCalendarDay()&&Date.parse(item.scheduledFor)>Date.now()&&
    /睡前|入睡|就寝|睡觉/.test(item.title)?item:null;
  const actions={};
  for (const topic of ['sleep','workout']) if (scope?.selectedTypes.includes(topic)) {
    const presentation=dayPresentation(topic,agenda,localSleep);
    if (presentation&&topic==='sleep'&&localSleep&&agenda?.sleepReminderAt&&Date.parse(localSleep.scheduledFor)!==Date.parse(agenda.sleepReminderAt)) {
      presentation.sub=[presentation.sub,'iPhone 另有 '+formatTime(localSleep.scheduledFor)+' 的提醒'].filter(Boolean).join(' · ');
    }
    if (presentation) actions[topic]=presentation;
    else if (grant?.topics.includes(topic)) actions[topic]={title:topic==='sleep'?'今晚的睡眠安排待定':'今天的运动安排待定',
      status:agenda?'DSH 暂无建议':'等待 DSH 更新',sub:'',date:localCalendarDay()};
  }
  const consumes=!!localSleep||agenda&&item&&['sleepReminderAt','workoutReminderAt'].some(k=>Date.parse(agenda[k])===Date.parse(item.scheduledFor)&&item.requestId===agenda.requestId);
  return {ids,actions,agenda,consumes};
}
function dailyRowContent(topic,d,extra='') {
  const topicLabel=topic==='sleep'?'睡眠':'运动';
  return `<div class="task-meta"><span>今天 · ${topicLabel}${d.source?' · DSH 已规划':''}</span>${d.source&&d.status==='DSH 已规划'?'':`<span class="day-status">${esc(d.status)}</span>`}</div><strong>${esc(d.title)}</strong>${d.sub?`<p class="day-sub">${esc(d.sub)}</p>`:''}${extra}`;
}
function unattachedDailyRows(ctx) {
  return Object.entries(ctx.actions).filter(([topic])=>!ctx.ids[topic]).map(([topic,day])=>
    `<div class="generated-task day-task" data-daily-topic="${topic}">${dailyRowContent(topic,day)}</div>`).join('');
}
function adaptiveTaskSection(layout) {
  const kinds={reminder:'定时提醒',agent_action:'Agent 处理',recommendation:'推荐'};
  const workout=localWeeklyWorkoutProgress(layout),ctx=dailyCardContext(layout,workout);
  const taskButton=task=>{
    const timing=task.kind==='reminder'&&task.scheduledFor?formatDate(task.scheduledFor):task.when;
    const meta=[kinds[task.kind],timing].filter(Boolean).join(' · ');
    const weekly=task.id===workout?.id;
    const body=weekly?`<div data-weekly-workout-progress><p>本周运动 <strong>${workout.minutes} / ${workout.target}</strong> 分钟</p><span>${esc(workout.remaining)}</span></div>`:`<p>${esc(task.detail)}</p>`;
    const hint=localOnlyTask(task)?'查看任务':'查看任务协作';
    const topic=Object.keys(ctx.actions).find(t=>ctx.ids[t]===task.id),daily=ctx.actions[topic];
    const inner=daily?dailyRowContent(topic,daily,weekly?body:''):`<div class="task-meta"><span>${esc(meta)}</span><span class="state-pill">${esc(taskStateLabel[task.state])}</span></div><strong>${esc(task.title)}</strong>${body}`;
    const button=`<button class="generated-task generated-task-button${daily?' day-task':''}" data-action="open-task" data-task-id="${esc(task.id)}"${daily?` data-daily-topic="${topic}"`:''}>${inner}<span class="task-open-hint">${daily?'查看今天的安排':hint}</span></button>`;
    if (!weekly||!workout.history.length) return button;
    const history=workout.history.map(line=>`<p>${esc(line)}</p>`).join('');
    return `<article data-weekly-task="${esc(task.id)}">${button}<details class="workout-history" ${homeDisclosure('workout/'+task.id)}><summary>近两期运动记录</summary>${history}</details></article>`;
  };
  const ordered=[...layout.tasks].sort((a,b)=>Number(Object.keys(ctx.actions).some(t=>ctx.ids[t]===b.id))-Number(Object.keys(ctx.actions).some(t=>ctx.ids[t]===a.id)));
  const visible=unattachedDailyRows(ctx)+ordered.slice(0,2).map(taskButton).join('');
  const later=ordered.slice(2);
  return `<section class="task-section adaptive-tasks" aria-label="动态任务"><div class="section-heading"><h2>动态任务</h2>${hasHealthSource(activeGoal)?'':'<span>Along 根据目标与情境生成</span>'}</div>${ctx.consumes?'':nextReminderLine()}${taskProposalCard()}<div class="adaptive-task-card">${visible}${later.length?`<details class="adaptive-more"><summary>查看其余 ${later.length} 项任务</summary>${later.map(taskButton).join('')}</details>`:''}${layout.questions.length?`<div class="missing-strip">待确认 ${layout.questions.length} 项：${esc(layout.questions[0])}</div>`:''}<div class="card-actions"><button class="agent-action" data-action="${canGiveTaskInstruction(activeGoal)?'task-instruction':'edit-goal'}">补充信息</button></div></div>${healthReviewDetails()}</section>`;
}
function adaptiveConnectionSection(layout) {
  if (!layout.connections?.length) return '';
  return `<section class="connection-section" aria-label="Along 推荐的连接"><div class="section-heading"><h2>连接</h2><span>在规划中发现的可用能力</span></div>${layout.connections.map(connection=>`<div class="connection-card"><div class="connection-symbol" aria-hidden="true">${connection.id==='duolingo'?'D':'·'}</div><div class="connection-copy"><div class="connection-name"><strong>${esc(connection.name)}</strong><span class="source-tag">${connection.status==='recommended'?'推荐连接':'待确认'}</span></div><p>${esc(connection.reason)}</p></div><button class="agent-action connection-agent-action" data-action="connection-detail" data-connection-id="${esc(connection.id)}">查看</button></div>`).join('')}</section>`;
}
function goalListTitle(title) {
  return /(日语|Japanese|N5|五十音)/i.test(title)?'日语学习':title;
}
function home() {
  readNextGoalReminder(activeGoal);
  readDailyAgenda(activeGoal);
  const linked=hasHealthSource(activeGoal);
  const suggestedHealth=offersHealthSource(activeGoal);
  const model = activeGoal === 'finance' ? financeView(finance, goalCustom.finance) : isCustomGoalKey(activeGoal) ? customView(activeGoal) : healthView(localHealthViewState(), goalCustom.health);
  const layout=goalLayouts[activeGoal];
  const customOptions=customGoalEntries(goalCustom,goalLayouts)
    .map(item=>`<option value="${esc(item.key)}" ${activeGoal===item.key?'selected':''}>${esc(goalListTitle(item.title))}</option>`)
    .join('');
  const isHealthConnection=activeGoal==='health'||linked||suggestedHealth;
  const connection=isHealthConnection?healthConnection(activeGoal):model.connection;
  const sourceTime = linked && nativeHealthStatus==='available' && state.snapshot?.updatedAt && state.source === 'healthkit'
    ? ` · ${formatDate(state.snapshot.updatedAt)} 已检查` : '';
  const goalContent=layout?adaptiveGoalCard(layout):`<section class="goal-card" aria-label="${esc(model.category)}">
        <div class="goal-card-top"><span class="eyebrow">${esc(model.category)}</span></div>
        <h1>${esc(model.title)}</h1>
        <div class="goal-numbers"><strong>${esc(model.measure)}</strong><span>${esc(model.measureUnit)}</span></div>
        <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${model.percent}" aria-label="目标进度"><span style="width:${model.percent}%"></span></div>
        <p class="progress-caption">${esc(model.progressText)}</p>
        <p class="goal-note">${esc(model.note)}</p>
        <div class="card-actions"><button class="agent-action" data-action="edit-goal">编辑目标</button></div>
      </section>`;
  const taskContent=layout?adaptiveTaskSection(layout):`<section class="task-section" aria-label="动态任务">
        <div class="section-heading"><h2>动态任务</h2>${linked?'':'<span>随目标与数据更新</span>'}</div>
        ${nextReminderLine()}${taskProposalCard()}${unattachedDailyRows(dailyCardContext(null,null))}
        <div class="focus-task"><div class="focus-top"><span>下一步</span><span class="task-chip">${esc(model.primary.status)}</span></div><h3>${esc(model.primary.title)}</h3><p>${esc(model.primary.detail)}</p><div class="card-actions"><button class="agent-action" data-action="${canGiveTaskInstruction(activeGoal)?'task-instruction':'edit-goal'}">补充信息</button></div></div>
        ${model.secondary.length ? `<div class="task-list">${model.secondary.map((task,index) => `<button class="task-row task-row-button" data-action="open-task" data-task-id="follow-up-${index}"><span class="task-row-mark" aria-hidden="true"></span><div><strong>${esc(task.title)}</strong><p>${esc(task.detail)}</p></div><span class="task-row-status">${esc(task.status)}</span></button>`).join('')}</div>` : ''}
        ${healthReviewDetails()}
      </section>`;
  const connectionContent=connection?`<section class="connection-section" aria-label="连接来源">
        <div class="section-heading"><h2>连接</h2><span>连接和任务相关的数据源</span></div>
        <div class="connection-card"><div class="connection-symbol" aria-hidden="true">${isHealthConnection ? '♥' : '¥'}</div><div class="connection-copy"><div class="connection-name"><strong>${esc(connection.name)}</strong><span class="source-tag ${connection.kind}">${esc(connection.label)}</span></div><p>${esc(connection.detail)}${esc(sourceTime)}</p></div><button class="agent-action connection-agent-action" data-action="${isHealthConnection ? connection.actionId : connection.kind === 'demo' ? 'finance-event' : 'connect-finance'}">${esc(connection.action)}</button></div>
        ${connection.metrics?.length ? `<div class="connection-metrics">${connection.metrics.map(item=>`<div><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong></div>`).join('')}</div>` : ''}
        ${activeGoal === 'health' && (state.source === 'demo' || hasRealHealthData()) ? `<button class="minor-action" data-action="clear-health-data">${hasRealHealthData() ? '清除本机健康摘要' : '退出健康演示数据'}</button>` : ''}
        ${activeGoal === 'finance' && finance.connected ? '<p class="connection-footnote">点“模拟 +¥800”只会更新这份本机演示数据，不会访问账户或发起交易。</p>' : ''}
      </section>`:'';
  const recommendedConnectionContent=layout?adaptiveConnectionSection(layout):'';
  return `<div class="app-shell"><header class="topbar"><div class="topbar-inner">${brand()}</div></header>
    <main class="content ${layout?'adaptive-space':''}">
      <div class="goal-switch"><label for="goal-select">当前目标</label><div class="goal-switch-actions"><div class="select-wrap"><select id="goal-select" aria-label="切换目标"><option value="health" ${activeGoal === 'health' ? 'selected' : ''}>健康 · ${goalLayouts.health?'个性化计划':'每周运动'}</option><option value="finance" ${activeGoal === 'finance' ? 'selected' : ''}>理财 · ${goalLayouts.finance?'个性化计划':'应急储备'}</option>${customOptions}<option value="new-custom">＋ 新建目标</option></select><span aria-hidden="true">⌄</span></div><button class="goal-add-button" data-action="new-goal">新建</button></div></div>
      <div class="runtime-switch home-runtime-switch" role="group" aria-label="选择 Agent 运行时"><button type="button" data-action="select-runtime" data-runtime="${DSH_RUNTIME}" class="${agentRuntime===DSH_RUNTIME?'active':''}" aria-pressed="${agentRuntime===DSH_RUNTIME}">DSH Agents</button><button type="button" data-action="select-runtime" data-runtime="${KIMI_RUNTIME}" class="${agentRuntime===KIMI_RUNTIME?'active':''}" aria-pressed="${agentRuntime===KIMI_RUNTIME}">Kimi Swarm</button></div>
      ${goalContent}
      ${taskContent}

      ${linked&&readStored(scopedKey(REMINDER_SYNC_KEY,activeGoal),null)?.error?'<p class="connection-footnote">计划已保存，系统提醒待同步。<button class="minor-action" data-action="retry-health-reminders">重试提醒</button></p>':''}
      ${connectionContent}
      ${recommendedConnectionContent}
      ${activeGoal === 'health' ? '<button class="lab-entry" data-action="open-lab">查看目标变化实验 <span aria-hidden="true">↗</span></button>' : ''}
    </main><footer>Along · 一起，慢慢向前</footer></div>`;
}

function taskAgentCard(agent,taskDetail=false) {
  const status=AGENT_STATUSES.has(agent.status)?agent.status:'';
  const recorded=Number.isFinite(agent.progress);
  const raw=recorded?agent.progress:agent.status==='done'?100:agent.status==='working'?55:agent.status==='blocked'?85:0;
  const progress=Math.max(0,Math.min(100,raw));
  return `<article class="worker-card ${status}"><div class="worker-card-head"><span class="worker-mark" aria-hidden="true">A</span><div><strong>Along</strong><span>协作单元</span></div><span class="worker-state">${esc(agentStateLabel[agent.status]||agent.status)}</span></div>${agent.objective?`<p class="worker-objective">${esc(agent.objective)}</p>`:''}${taskDetail!==true||recorded?`<div class="worker-progress"><span style="width:${progress}%"></span></div>`:''}${agent.work?`<p class="worker-now"><span>当前</span>${esc(agent.work)}</p>`:''}${agent.report?.summary?`<p class="worker-output"><span>报告</span>${esc(agent.report.summary)}</p>`:''}</article>`;
}
function taskReasonText(reason) {
  if (typeof reason==='string') return reason;
  if (typeof reason?.values?.text==='string') return reason.values.text;
  if (typeof reason?.code!=='string') return '';
  return ({noRuleMatched:'没有匹配的接单规则',senderNotMember:'请求者未列入当前来源的授权名单',directionUnsettled:'执行意图或方向还需确认',
    noAdmissible:'此请求未通过接单评估',timeout:'接单评估超时',policyChanged:'评估期间接单规则发生变化',humanStop:'用户已要求停止'})[reason.code]||reason.code;
}
function taskExecutionRecord(run) {
  const workers=run.assignments.filter(agent=>agent.objective||agent.work||agent.report?.summary||agent.status);
  const events=run.events.filter(event=>event.text);
  const ticket=run.ticket?.id;
  const mandate=run.mandate;
  const mandateText=typeof mandate==='string'?mandate:[mandate?.scope,mandate?.strength==='explicit'?'明确授权':'',
    mandate?.actor?.id?`请求者 ${mandate.actor.id}`:'',typeof mandate?.policyVersion==='string'?`Policy ${shortText(mandate.policyVersion)}`:''].filter(value=>typeof value==='string'&&value).join(' · ');
  return `${ticket?`<section class="task-record"><h2>${run.runtime===KIMI_RUNTIME?'Kimi 会话':'DSH 工单'}</h2>${typeof run.ticket.title==='string'?`<p>${esc(run.ticket.title)}</p>`:''}<p>${esc(ticket)}</p></section>`:''}
    ${mandateText?`<div class="mandate-card"><span>本次授权边界</span><p>${esc(mandateText)}</p></div>`:''}
    ${workers.length?`<section class="workers-section"><div class="section-heading"><h2>任务分工</h2><span>${workers.filter(agent=>agent.status==='done').length} / ${workers.length} 已完成</span></div><div class="worker-grid">${workers.map(agent=>taskAgentCard(agent,true)).join('')}</div></section>`:''}
    ${events.length?`<section class="activity-section"><div class="section-heading"><h2>工作记录</h2></div><div class="activity-list">${events.map(event=>`<div class="activity-row"><span class="activity-dot"></span><div><strong>${esc(event.text)}</strong><span>${formatTime(event.at)}</span></div></div>`).join('')}</div></section>`:''}`;
}
function taskDetailPage() {
  const task=selectedTask();
  if (!task) {
    return `<div class="app-shell"><header class="topbar"><div class="topbar-inner">${brand()}<span class="topbar-caption">Along</span></div></header><main class="content task-detail">${backButton('task-back','返回动态任务')}<div class="empty-task"><h1>任务已更新</h1><p>这项动态任务已不在当前计划中，请返回查看最新安排。</p></div></main></div>`;
  }
  const local=localOnlyTask(task),run=currentSuperAgentRun(task),actual=run?.actual===true;
  const stopped=actual&&stoppedTaskDecision(run);
  const submitting=!actual&&superAgentRequests.has(taskCallKey(task));
  const meta=runtimeMeta();
  let status,reason='',action='',button='';
  if (local) {
    status='仅在本机';
    reason=`按你之前的健康授权范围，任务原文仅保存在本机，本次未提交给 ${meta.short}。`;
  } else if (actual) {
    status=stopped?({ignore:'未接受任务',unavailable:'接单评估未完成',stop:'执行已停止'})[run.eval.decision]:run.statusLabel||'已接收';
    const reasons=stopped&&Array.isArray(run.eval.reasons)?run.eval.reasons.map(taskReasonText).filter(Boolean):[];
    reason=[run.error,...reasons,(!run.error&&run.status==='blocked')?run.report?.summary:''].filter(item=>typeof item==='string'&&item).join(' ');
    if (stopped&&!reason) reason=`${meta.short} 已返回这项决定。`;
    if (run.refreshFailed) {action=agentConfig.token?'refresh-task':'edit-goal';button=agentConfig.token?'重新读取状态':'连接 Mac';}
    else if (stopped&&run.eval.decision==='unavailable') reason+=' 请在 Mac 查看接单评估。';
  } else if (!agentConfig.token && !run?.error) {
    status='待连接 Mac';reason='请先在“编辑目标”中连接这台 Mac，然后再打开任务。';action='edit-goal';button='连接 Mac';
  } else if (run?.error) {
    status='提交未获确认';reason=run.error;
    action=agentConfig.token?'retry-task':'edit-goal';button=agentConfig.token?'重试提交':'连接 Mac';
  } else {
    status=submitting?`正在提交给 ${meta.short}`:'待提交';
  }
  const layout=goalLayouts[activeGoal],dayCtx=dailyCardContext(layout,layout?localWeeklyWorkoutProgress(layout):null);
  const dayTopic=Object.keys(dayCtx.actions).find(t=>dayCtx.ids[t]===task.id),daily=dayCtx.actions[dayTopic];
  const showProgress=actual&&!stopped&&Number.isFinite(run.progress),percent=showProgress?runProgress(run.progress):0;
  return `<div class="app-shell super-agent-shell"><header class="topbar"><div class="topbar-inner">${brand()}<span class="topbar-caption">Along · ${local?'任务详情':'任务协作'}</span></div></header><main class="content task-detail">
    ${backButton('task-back','返回动态任务')}
    <section class="task-hero"><div class="task-hero-top"><span class="eyebrow">${esc(task.when)} · ${esc(taskStateLabel[task.state])}</span><span class="run-status ${actual?runStatus(stopped?'blocked':run.status):''}">${local?'':'<i></i>'}${esc(status)}</span></div><h1>${esc(task.title)}</h1><p>${esc(task.detail)}</p>
    ${showProgress?`<div class="run-progress-head"><span>总体进展</span><strong>${percent}%</strong></div><div class="run-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>`:''}</section>
    ${daily?`<section class="task-record day-detail" aria-label="今天的安排">${dailyRowContent(dayTopic,daily)}${dayCtx.agenda?`<p>${esc(dayCtx.agenda.reason)}</p><small>DSH 工单 · ${esc(dayCtx.agenda.ticketId)}</small>`:''}</section>`:''}
    ${reason?`<section class="task-record" aria-live="polite"><h2>${local?(daily?'原任务的分享范围':'为什么没有提交'):actual&&!stopped&&run.refreshFailed?'状态读取失败':'原因'}</h2><p>${esc(reason)}</p>${action?`<button class="minor-action" data-action="${action}">${button}</button>`:''}</section>`:''}
    ${actual?taskExecutionRecord(run):''}</main></div>`;
}

function goalOrchestrationPanel(run) {
  if (!run) return '';
  const meta=runtimeMeta(run.runtime);
  const events=(run.events||[]).filter(event=>event&&typeof event==='object').slice(-5);
  const mandateText=typeof run.mandate==='string'?run.mandate:run.mandate?.scope||'仅围绕本次目标进行拆解、规划与可交付执行。';
  return `<section class="goal-orchestration ${runStatus(run.status)}" aria-live="polite"><div class="goal-run-head"><div><span class="eyebrow">真实 ${esc(meta.full)}</span><h2>${esc(run.statusLabel)}</h2></div><strong>${runProgress(run.progress)}%</strong></div><div class="run-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${runProgress(run.progress)}"><span style="width:${runProgress(run.progress)}%"></span></div>
  <div class="orchestration-flow compact"><div><span>Source</span><strong>目标输入</strong></div><b aria-hidden="true">→</b><div><span>${run.runtime===KIMI_RUNTIME?'Session':'Main Session'}</span><strong>${run.eval?.decision==='accept'?'已接单':run.eval?.decision==='evaluating'?'评估中':'等待'}</strong></div><b aria-hidden="true">→</b><div><span>${run.runtime===KIMI_RUNTIME?'Swarm':'Ticket'}</span><strong>${run.runtime===KIMI_RUNTIME?'已开启':run.ticket?esc(shortText(run.ticket?.id)):'创建中'}</strong></div><b aria-hidden="true">→</b><div><span>${esc(meta.worker)}</span><strong>${run.agents?.length||0} 个 Agent</strong></div></div>
  ${run.mandate?`<div class="mandate-card"><span>Mandate · 本次授权边界</span><p>${esc(mandateText)}</p></div>`:''}
  ${run.agents?.length?`<div class="worker-grid">${run.agents.filter(agent=>agent&&typeof agent==='object').map(taskAgentCard).join('')}</div>`:''}
  ${events.length?`<div class="goal-run-events">${events.map(event=>`<p><span>${formatTime(event.at)}</span>${esc(event.text)}</p>`).join('')}</div>`:''}
  ${run.error?`<p class="goal-run-error">${esc(run.error)}</p>`:''}</section>`;
}

function agentPreview(item,goal,domain) {
  if (!item.proposal && !item.layout) return '';
  const change=goalChangeText(goal,item.proposal,domain);
  const goalChange=item.proposal?`<span>目标变化：${change}</span><strong>${esc(item.proposal.title)}</strong><p>下一步：${esc(item.proposal.task)}</p><p>${esc(item.proposal.reason)}</p>`:'';
  const layoutPreview=item.layout?`<span>Along 生成的目标空间</span><strong>${esc(item.layout.title)}</strong><p>${esc(item.layout.summary)}</p><p>${item.layout.modules.length} 个目标模块 · ${item.layout.tasks.length} 项动态任务 · ${item.layout.questions.length} 项待确认</p>`:'';
  // 句柄用这一轮运行的 requestId，不用数组下标：对话超过 20 条会滚动丢旧记录，下标会错位。
  return `<div class="proposal-preview">${goalChange}${layoutPreview}<button class="button" data-action="accept-goal" data-request-id="${esc(item.requestId||'')}">${item.proposal?'确认采用目标与界面':'采用这个目标空间'}</button></div>`;
}
function agentMessage(item,goal,domain) {
  return `<div class="agent-message ${item.role}"><p>${esc(item.text)}</p>${agentPreview(item,goal,domain)}</div>`;
}
function agentPending(id) {
  return `<div class="agent-message assistant pending" data-agent-run="${esc(id)}" role="status"><div class="agent-thinking"><span aria-hidden="true"><i></i><i></i><i></i></span><p>正在连接 ${esc(runtimeMeta().full)}…</p></div></div>`;
}
function setAgentComposerBusy(busy) {
  const form=app.querySelector('#agent-form');
  const button=form?.querySelector('.agent-send');
  if (form) form.setAttribute('aria-busy',String(busy));
  if (button) button.disabled=busy || !agentConfig.token;
}
function scrollAgentConversationToBottom() {
  requestAnimationFrame(()=>{
    const scroller=app.querySelector('.agent-scroll');
    scroller?.scrollTo({top:scroller.scrollHeight,behavior:'smooth'});
  });
}
function goalAgentPage() {
  const goalKey=activeGoal;
  const domain=goalDomain(goalKey);
  const goal=currentGoal();
  const history=conversations[goalKey] || [];
  const goalRun=currentGoalSuperAgentRun(goalKey);
  const goalRunning=goalRun?.status==='working';
  const meta=runtimeMeta();
  const label=domain==='health'?'健康':domain==='finance'?'理财演示':goalCustom[goalKey]?.title?goalListTitle(goalCustom[goalKey].title):'新建目标';
  const weeklyMinutes=domain==='health'?reviewFor(goalKey).workoutTarget(true):null;
  const targetText=domain==='health'?(weeklyMinutes?`每周运动 ${weeklyMinutes} 分钟`:'按已确认的目标要求执行'):domain==='finance'?`¥${goal.target.toLocaleString('zh-CN')}`:'由你用自然语言定义';
  const connectionText=agentConnection.status==='ready'?[`Along 与 ${meta.short} 已连接`,'整条目标编排链路可用','已验证']:
    agentConnection.status==='error'?['连接需处理',agentConnection.error,'需处理']:['正在检查连接',`正在验证 Mac Host 与 ${meta.full}`,'检查中'];
  return `<div class="app-shell agent-shell"><header class="topbar"><div class="topbar-inner">${brand()}</div></header><main class="content agent-page"><div class="agent-scroll">${backButton('agent-back','返回目标')}<div class="agent-title"><span class="eyebrow">${label} · ${esc(meta.full)}</span><h1>${esc(goal.title)}</h1><p>当前目标：${targetText}。${esc(meta.description)}确认后才会改变首页。</p></div>
  <div class="runtime-switch" role="group" aria-label="选择 Agent 运行时"><button type="button" data-action="select-runtime" data-runtime="${DSH_RUNTIME}" class="${agentRuntime===DSH_RUNTIME?'active':''}" aria-pressed="${agentRuntime===DSH_RUNTIME}">DSH Agents</button><button type="button" data-action="select-runtime" data-runtime="${KIMI_RUNTIME}" class="${agentRuntime===KIMI_RUNTIME?'active':''}" aria-pressed="${agentRuntime===KIMI_RUNTIME}">Kimi Swarm</button></div>
  ${agentConfig.token ? `<div class="agent-status ${agentConnection.status}"><strong>${esc(connectionText[0])}</strong><span>${esc(connectionText[1])}</span><em>${esc(connectionText[2])}</em></div>` : `<div class="agent-setup"><h2>首次连接 Along</h2><p>只需设置一次，之后会自动恢复。让 Mac 与 iPhone 保持在同一网络，启动 Along 服务后填入一次连接信息。</p><form id="pair-form"><input name="baseURL" placeholder="Along 服务地址" value="${esc(agentConfig.baseURL||'')}" required><input name="fingerprint" placeholder="连接指纹" value="${esc(agentConfig.fingerprint||'')}" required><input name="code" placeholder="一次性连接码" inputmode="numeric" required><button class="button" ${agentBusy?'disabled':''}>${agentBusy?'连接中…':'连接 Along'}</button></form></div>`}
  ${agentConfig.token&&agentConnection.status==='error'?`<details class="agent-setup"><summary>Mac 的 Wi-Fi 地址变了？</summary><form id="host-address-form"><label>新的 Along 服务地址<input name="baseURL" type="url" value="${esc(agentConfig.baseURL||'')}" required></label><button class="button">验证并更新</button></form></details>`:''}
  <div class="agent-messages" role="log" aria-live="polite">${history.length?history.map(item=>agentMessage(item,goal,domain)).join(''):'<p class="agent-empty">说说你希望达成什么、期限、约束和偏好；Along 会先整理并请你确认。</p>'}</div>
  ${goalOrchestrationPanel(goalRun)}
  </div><div class="agent-composer-dock"><form id="agent-form" class="agent-composer" aria-busy="${agentBusy||goalRunning}"><textarea name="message" rows="1" placeholder="描述你的目标" maxlength="800" required ${goalRunning?'disabled':''}></textarea><button class="agent-send" aria-label="交给 Super Agent" title="交给 Super Agent" ${agentBusy||goalRunning||!agentConfig.token?'disabled':''}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m0 0L6.5 8.5M10 5l3.5 3.5"/></svg></button></form><p class="agent-disclaimer">${goalRunning?'Super Agent 编排中…':domain==='finance'?'理财连接和余额仍是演示；Super Agent 只规划，不交易。':domain==='health'?'仅发送当前目标与所选健康摘要，不发送原始记录。':'Along · 一起，慢慢向前'}</p></div></main></div>`;
}

function currentGoal(goalKey=activeGoal) {
  return goalKey==='health' ? {domain:'health',title:goalCustom.health?.title || goalLayouts.health?.title || `本周累计运动 ${state.goals.find(item=>item.type==='workout')?.target||120} 分钟`,target:state.goals.find(item=>item.type==='workout')?.target||120} : goalKey==='finance' ? {domain:'finance',title:goalCustom.finance?.title || '三个月存下 ¥10,000 应急金',target:goalCustom.finance?.target||10000} : {domain:'custom',title:goalCustom[goalKey]?.title || goalLayouts[goalKey]?.title || '定义我的新目标',target:null};
}
function currentSummary() {
  return activeGoal==='health' ? scopedSnapshot('health') : activeGoal==='finance' ? {saved:finance.connected?finance.saved:null} : {};
}
function agentGoal(goalKey) {
  const goal=currentGoal(goalKey);
  return goalKey!=='finance'&&reviewFor(goalKey).sharing.localGoalTitle?{...goal,title:'我的健康目标'}:goal;
}
function saveConversations() { localStorage.setItem(CONVERSATIONS_KEY,JSON.stringify(conversations)); }
function saveGoalCustom() { localStorage.setItem(GOALS_KEY,JSON.stringify(goalCustom)); }
function saveGoalLayouts() { localStorage.setItem(ADAPTIVE_LAYOUTS_KEY,JSON.stringify(goalLayouts)); }
function applyGeneratedGoal(goalKey,item) {
  if (!item?.proposal && !item?.layout) return false;
  const domain=goalDomain(goalKey);
  const validatedLayout=item.layout?validateAdaptiveLayout(item.layout,domain):null;
  const run=currentGoalSuperAgentRun(goalKey);
  const requestIntent=item.userIntent||(run?.requestId===item.requestId?run.input?.message:'');
  if (item.proposal||requestIntent) {
    goalCustom[goalKey]={...goalCustom[goalKey],...item.proposal,
      intent:`${goalCustom[goalKey]?.intent||''}\n${requestIntent||''}`.trim().slice(-1600)};
    if (goalKey==='health'&&item.proposal) saveHealth({...state,goals:state.goals.map(goal=>goal.type==='workout'?{...goal,target:item.proposal.target}:goal)});
  }
  if (validatedLayout) goalLayouts[goalKey]=validatedLayout;
  saveGoalCustom();
  saveGoalLayouts();
  if (hasHealthSource(goalKey)) reviewFor(goalKey).goalUpdated(item,validatedLayout);
  return true;
}
function consumeGoalProposal(goalKey,index) {
  conversations[goalKey]=conversations[goalKey].map((entry,i)=>i===index?{...entry,proposal:null,layout:null}:entry);
  saveConversations();
}
function adoptPendingInitialCustomGoal() {
  const candidate=findInitialCustomGoalCandidate(conversations.custom,goalCustom.custom,goalLayouts.custom);
  if (!candidate) return false;
  try {
    applyGeneratedGoal('custom',candidate.item);
    consumeGoalProposal('custom',candidate.index);
    activeGoal='custom';
    localStorage.setItem(ACTIVE_GOAL_KEY,activeGoal);
    return true;
  } catch { return false; }
}

function experimentPanel() {
  const loop = state.loop?.experiment === EXPERIMENT ? state.loop : null;
  const latest = loop?.changes?.find(item => item.decision === 'replan');
  const quiet = loop?.changes?.filter(item => item.decision === 'quiet').length ?? 0;
  return `<section class="lab-card">${loop ? `<div class="lab-head"><div><strong>本周健身 120 分钟</strong><p>从 75 分钟开始，观察任务何时改变。</p></div><button class="minor-action" data-action="experiment-reset">重新开始</button></div><div class="lab-actions"><button class="button" data-action="event-workout-35" ${running ? 'disabled' : ''}>新增 35 分钟</button><button class="button secondary" data-action="event-workout-1" ${running ? 'disabled' : ''}>仅新增 1 分钟</button><button class="button secondary" data-action="event-steps" ${running ? 'disabled' : ''}>仅步数变化</button></div>${latest ? `<div class="change-card"><span class="eyebrow">${latest.status === 'pending' ? '正在请求 Along…' : latest.status === 'error' ? '建议暂不可用' : latest.source === 'live-along' ? 'Along 实时建议' : 'Along 建议回放'}</span><div class="change-flow"><div><span>原任务</span><strong>${esc(latest.beforeTask)}</strong></div><span class="flow-arrow">→</span><div><span>新任务</span><strong>${esc(latest.suggestion?.task ?? (latest.status === 'error' ? '尚未生成' : '生成中…'))}</strong></div></div><p>${latest.remainingBefore} → ${latest.remainingAfter} 分钟待完成。${esc(latest.reason)} ${esc(latest.suggestion?.reason ?? '')}</p>${latest.status === 'error' ? `<p>${esc(latest.error)}</p>` : ''}${latest.source === 'recorded-along' ? '<p>公网版显示已录制的 Along 运行结果。</p>' : ''}</div>` : '<p class="lab-hint">轻微或无关变化会安静处理；显著变化才请求新任务。</p>'}${quiet ? `<p class="lab-hint">${quiet} 条变化已安静处理，没有调用 Along。</p>` : ''}` : `<div class="lab-head"><div><strong>看一次目标驱动的调整</strong><p>预设本周 120 分钟、已完成 75 分钟。</p></div></div><button class="button lab-start" data-action="experiment-start">开始实验</button>`}</section>`;
}
function lab() {
  return `<div class="app-shell"><header class="topbar"><div class="topbar-inner">${brand()}<span class="topbar-caption">目标变化实验</span></div></header><main class="content lab-content">${backButton('back-home','返回目标')}<h1>当进度变化，下一步会怎样变？</h1><p class="lab-intro">这是与真实健康数据隔离的模拟实验。Along 计算进度，再判断是否需要更新建议。</p>${experimentPanel()}</main></div>`;
}
function render() { app.innerHTML = screen === 'lab' ? lab() : screen === 'agent' ? goalAgentPage() : screen === 'task' ? taskDetailPage() : home(); queueBackgroundSync(); }
function renderAgentUpdate({follow=false}={}) {
  const previous=app.querySelector('.agent-scroll');
  if (!previous) {render();return;}
  const scrollTop=previous.scrollTop;
  const nearBottom=previous.scrollHeight-previous.scrollTop-previous.clientHeight<160;
  render();
  const next=app.querySelector('.agent-scroll');
  if (!next) return;
  next.scrollTop=follow||nearBottom?next.scrollHeight:Math.min(scrollTop,Math.max(0,next.scrollHeight-next.clientHeight));
}
window.__alongNavigateBack = () => {
  const button=app.querySelector('.back-button[data-action]');
  if (!button) return false;
  button.click();
  return true;
};

function connectInfo() {
  show(`<div class="sheet-head"><h2>连接 Apple Health</h2><button class="icon-button" data-action="close" aria-label="关闭">×</button></div><p class="sheet-copy">只有 iPhone App 可以读取 Apple Health。你可逐项选择、预览摘要，再决定是否导入本机 Along。</p><div class="permission-list"><span>步数</span><span>健身</span><span>体重</span><span>睡眠</span></div><button class="button sheet-main-button" data-action="health-demo">先体验演示数据</button><p class="sheet-footnote">演示数据不会显示为真实连接。</p>`);
}
async function connectHealth(goalKey=activeGoal) {
  if (!window.AlongHealthBridge?.connect) { connectInfo(); return; }
  try {
    const previousTypes=state.source==='healthkit'&&nativeHealthStatus==='available'&&state.snapshot?.contextReviewAllowed
      ? state.snapshot.selectedTypes||[]:[];
    const snapshot = await window.AlongHealthBridge.connect({goalKey,types:['steps','weight','workout','sleep']});
    sourceGeneration++;
    nativeHealthStatus='available';
    nativeObservationSeen=true;
    if (isCustomGoalKey(goalKey)&&!Array.isArray(goalCustom.health?.healthTypes)) {
      // The first import for a named goal grants no new access to the default goal.
      goalCustom.health={...goalCustom.health,healthTypes:previousTypes};
      saveGoalCustom();
    }
    saveHealth(setSnapshot(state,snapshot,'healthkit'));
    if (snapshot.contextReviewAllowed===true) bindHealthSource(goalKey,false);
    void reviewAll();
    notice('健康数据已导入本机');
  } catch (error) { notice(error?.message || '连接未完成，请检查健康权限'); }
}

// 本机是否还留着一份真实健康摘要：界面上这份，或目标变化实验开始前存下的那份备份。
function hasRealHealthData() { return state.source === 'healthkit' || state.loop?.previousState?.source === 'healthkit'; }

// 清掉本机保存的健康摘要；真实来源还要让原生侧停掉读取，否则下一轮刷新会把它读回来。
async function clearHealthData() {
  sourceGeneration++;
  const real = hasRealHealthData();
  let stopped = true;
  if (real) { try { await window.AlongHealthBridge?.clear?.(); } catch { stopped = false; } }
  // 任务票里存着真实健身分钟数：只要它在，每次清除健康数据都要一起清掉，
  // 不管当前界面显示的是真实来源还是演示数据。
  for (const key of healthGoalKeys()) {
    reviewFor(key).clear();
    replaceHealthReminders(newId('clear'),key,true);
  }
  const cleared = {...state, source:null, snapshot:null};
  if (state.loop) cleared.loop = {...state.loop, previousState: state.loop.previousState ? {...state.loop.previousState, source:null, snapshot:null} : undefined};
  nativeHealthStatus=window.AlongHealthBridge?.refresh?'unlinked':'available';
  nativeObservationSeen=false;
  saveHealth(cleared);
  for (const key of healthGoalKeys().filter(isCustomGoalKey)) delete goalCustom[key].healthTypes;
  saveGoalCustom();
  if (screen==='home') render();
  notice(real ? (stopped ? '已清除本机健康摘要，并停止读取 Apple Health' : '已清除本机健康摘要；请到系统设置里撤销 Apple Health 权限') : '已退出健康演示数据');
}

async function loadReplay() {
  return fetch('./agent-replay.json').then(response => response.json());
}
async function injectEvent(event) {
  if (running) return;
  const localAgent = ['localhost', '127.0.0.1'].includes(location.hostname);
  let before = state;
  // 公网版回放的是一段录好的 Along 运行，它固定从回放文件声明的起点开始。
  // 用户先点过一次安静的变化，起点就偏了，主场景再也点不出来——README 承诺
  // 两个按钮都是文档化的用法。先把实验拨回那个起点，主场景就始终可用
  // （已经发生过的变化记录保留，安静处理的那几条还要看得见）。
  if (!localAgent && event.type==='workout' && event.amount===35) {
    const replay=await loadReplay();
    if (replay?.beforeMinutes!=null && before.snapshot?.workoutMinutes!==replay.beforeMinutes) {
      const restarted=startExperiment(before);
      before={...restarted,loop:{...restarted.loop,changes:before.loop?.changes ?? []}};
      saveHealth(before);
    }
  }
  let route;
  try { route = routeHealthEvent(before, event); } catch (error) { notice(error.message); return; }
  const id = newId('change');
  const entry = {id, type:event.type, amount:event.amount, decision:route.decision, reason:route.reason, remainingBefore:route.remainingBefore, remainingAfter:route.remainingAfter, beforeTask:before.loop.currentTask, status:route.decision === 'quiet' ? 'quiet' : 'pending'};
  if (route.decision === 'replan') running = true;
  saveHealth({...route.after, loop:{...before.loop, changes:[entry, ...before.loop.changes]}});
  if (route.decision === 'quiet') return;
  try {
    let result;
    if (!localAgent && event.type === 'workout' && event.amount === 35) {
      const replay = await loadReplay();
      if (replay.experiment !== EXPERIMENT || replay.beforeMinutes !== 75 || replay.eventMinutes !== 35) throw Error('回放场景不匹配');
      result = {decision:'replan', source:'recorded-along', suggestion:replay.suggestion};
    } else if (localAgent) {
      const response = await fetch('./api/health-event', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(agentRequestPayload(before, event))});
      result = await response.json();
      if (!response.ok) throw Error(result.error || 'Along 请求失败');
    } else throw Error('公网演示仅提供 75＋35 分钟场景的 Along 回放');
    if (result.decision !== 'replan') throw Error('服务端没有确认重排');
    const suggestion = acceptAgentSuggestion(JSON.stringify(result.suggestion), route.remainingAfter);
    if (state.loop?.changes?.[0]?.id !== id) return;
    saveHealth({...state, loop:{...state.loop, currentTask:suggestion.task, changes:[{...entry, status:'done', suggestion, source:result.source}, ...state.loop.changes.slice(1)]}});
  } catch (error) {
    if (state.loop?.changes?.[0]?.id === id) saveHealth({...state, loop:{...state.loop, changes:[{...entry, status:'error', error:error.message}, ...state.loop.changes.slice(1)]}});
  } finally { running = false; render(); }
}

function beginNewGoal() {
  previousGoalBeforeDraft=activeGoal;
  activeGoal=`custom:${newId('goal')}`;
  conversations[activeGoal]=[];
  // 新目标在 Agent 回话落地前也是用户写下的东西：先落盘。
  // 否则 App 恰好在这段时间重启，用户写的目标和这句话会一起消失。
  localStorage.setItem(ACTIVE_GOAL_KEY,activeGoal);
  saveConversations();
  screen='agent';
  render();
  if (agentConfig.token) void refreshAgentConnection();
}

app.addEventListener('change', event => {
  if (event.target.id !== 'goal-select') return;
  if (event.target.value === 'new-custom') {
    beginNewGoal();
    return;
  }
  activeGoal = event.target.value === 'finance' || isCustomGoalKey(event.target.value) ? event.target.value : 'health';
  localStorage.setItem(ACTIVE_GOAL_KEY, activeGoal);
  render();
});
app.addEventListener('input', event => {
  if (!event.target.matches('#agent-form textarea')) return;
  event.target.style.height='auto';
  event.target.style.height=`${Math.min(event.target.scrollHeight,120)}px`;
});
app.addEventListener('click', event => {
  const actionTarget=event.target.closest('[data-action]');
  const action = actionTarget?.dataset.action;
  if (!action) return;
  if (action === 'connection-detail') {
    const connection=goalLayouts[activeGoal]?.connections?.find(item=>item.id===actionTarget.dataset.connectionId);
    if (!connection) return;
    show(`<div class="sheet-head"><h2>${esc(connection.name)}</h2><button class="icon-button" data-action="close" aria-label="关闭">×</button></div><p class="sheet-copy">${esc(connection.reason)}</p><div class="permission-list"><span>${esc(connection.capability)}</span></div>${connection.id==='duolingo'?'<button class="button sheet-main-button" data-action="open-duolingo">打开 Duolingo</button>':''}<p class="sheet-footnote">当前版本不会冒充账户已连接；学习进度只会在获得 Duolingo 授权后同步。</p>`);
    return;
  }
  if (action === 'new-goal') { beginNewGoal();return; }
  if (action === 'select-runtime') {
    const next=safeAgentRuntime(actionTarget.dataset.runtime);
    if (next===agentRuntime) return;
    agentRuntime=next;
    localStorage.setItem(AGENT_RUNTIME_KEY,agentRuntime);
    agentConnection={status:agentConfig.token?'checking':'unconfigured',error:''};
    renderAgentUpdate();
    if (agentConfig.token) void refreshAgentConnection();
    return;
  }
  if (action === 'open-task') {
    selectedTaskId=actionTarget.dataset.taskId || null;
    if (!selectedTaskId) return;
    screen='task';
    render();
    const task=selectedTask();
    if (task) void submitSuperAgentTask(task);
  }
  if (screen==='task' && (action==='retry-task'||action==='refresh-task')) {
    const task=selectedTask();
    if (task) {
      if (action==='refresh-task') void refreshSuperAgentTask(task,{retry:true});
      else void submitSuperAgentTask(task,{retry:true});
    }
  }
  if (action === 'task-back') { selectedTaskId=null;screen='home';render(); }
  if (action==='task-instruction'&&canGiveTaskInstruction(activeGoal)) {
    show(`<div class="sheet-head"><h2>让 Along 安排</h2><button class="icon-button" data-action="close" aria-label="关闭">×</button></div>
      <form id="task-instruction-form" class="agent-composer" data-goal="${esc(activeGoal)}"><textarea name="instruction" maxlength="300" required aria-label="这次想怎么安排" placeholder="例如：根据我的近期作息，安排今晚的睡觉提醒"></textarea>
      <button class="button sheet-main-button">交给 ${esc(agentRuntimeLabel(agentRuntime))} 安排</button></form>`);
  }
  if (action === 'edit-goal') { screen='agent'; render();if (agentConfig.token) void refreshAgentConnection(); }
  if (action === 'agent-back') {
    if (isCustomGoalKey(activeGoal) && !goalCustom[activeGoal] && !goalLayouts[activeGoal]) {
      const draft=activeGoal;
      delete conversations[draft];
      // 放弃了这份草稿：存储里要删干净——对话、运行记录、当前目标指针。
      // 少删一样，草稿就会在下一次重启时自己复活，用户被弹回他刚放弃的页面。
      const keptRuns=Object.fromEntries(Object.entries(goalSuperAgentRuns).filter(([key])=>!key.startsWith(`${draft}:`)));
      if (Object.keys(keptRuns).length!==Object.keys(goalSuperAgentRuns).length) {
        goalSuperAgentRuns=keptRuns;
        saveGoalSuperAgentRuns();
      }
      const keptTasks=Object.fromEntries(Object.entries(superAgentRuns).filter(([key])=>!key.startsWith(`${draft}:`)));
      if (Object.keys(keptTasks).length!==Object.keys(superAgentRuns).length) {
        superAgentRuns=keptTasks;
        saveSuperAgentRuns();
      }
      saveConversations();
      activeGoal=previousGoalBeforeDraft || 'health';
      previousGoalBeforeDraft=null;
      localStorage.setItem(ACTIVE_GOAL_KEY,activeGoal);
    }
    screen='home';
    render();
  }
  if (action === 'accept-goal') {
    const requestId=actionTarget.dataset.requestId;
    const list=conversations[activeGoal]||[];
    const index=requestId?list.findIndex(entry=>entry.requestId===requestId):-1;
    const item=index>=0?list[index]:null;
    if (!item?.proposal && !item?.layout) return;
    applyGeneratedGoal(activeGoal,item);
    consumeGoalProposal(activeGoal,index);
    if (isCustomGoalKey(activeGoal)) {
      localStorage.setItem(ACTIVE_GOAL_KEY,activeGoal);
      previousGoalBeforeDraft=null;
    }
    screen='home';render();notice(item.proposal&&item.layout?'目标、界面和下一步已更新':item.proposal?'目标与下一步已更新':'目标空间已更新');
  }
  if (hasHealthSource(activeGoal)) {
    const review=reviewFor(activeGoal);
    if (action==='review-access') openReviewAccess(activeGoal);
    if (action==='accept-task') review.accept();
    if (action==='dismiss-task') review.dismiss();
    if (action==='retry-health-review') void review.reviewHealthContext('retry');
    if (action==='retry-health-reminders') void syncHealthReminders(activeGoal);
  }
  if (action==='refresh-health') void refreshFromNative(true);
  if (action==='link-goal-health'&&(activeGoal==='health'||isCustomGoalKey(activeGoal))) {
    if (nativeHealthStatus==='available'&&state.source==='healthkit'&&state.snapshot?.contextReviewAllowed===true) bindHealthSource(activeGoal);
    else void connectHealth(activeGoal);
  }
  if (action === 'connect-health') connectHealth();
  if (action === 'connect-finance') { saveFinance(connectFinanceDemo()); notice('已打开理财演示连接'); }
  if (action === 'finance-event') { saveFinance(addFinanceDemoRecord(finance)); notice('已记录一笔 +¥800 演示结余'); }
  if (action === 'clear-health-data') void clearHealthData();
  if (action === 'open-lab') { screen = 'lab'; render(); }
  if (action === 'back-home') {
    screen = 'home';
    if (state.loop?.experiment === EXPERIMENT) saveHealth(state.loop.previousState ?? loadState(null));
    else render();
  }
  if (action === 'experiment-start' || action === 'experiment-reset') { if (!running) saveHealth(startExperiment(state)); }
  if (action === 'event-workout-35') injectEvent({type:'workout', amount:35});
  if (action === 'event-workout-1') injectEvent({type:'workout', amount:1});
  if (action === 'event-steps') injectEvent({type:'steps', amount:100});
});
app.addEventListener('submit', async event => {
  if (!['pair-form','agent-form','health-review-answer','host-address-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (event.target.id==='health-review-answer') {
    const answer=String(new FormData(event.target).get('answer')||'').trim().slice(0,300);
    if (answer&&hasHealthSource(activeGoal)) await reviewFor(activeGoal).answer(answer);
    return;
  }
  if (agentBusy) return;
  if (event.target.id==='agent-form' && currentGoalSuperAgentRun()?.status==='working') return;
  const formElement=event.target;
  const form=new FormData(formElement);
  if (formElement.id==='host-address-form') {
    const config={...agentConfig,baseURL:String(form.get('baseURL')||'').trim().replace(/\/$/,'')};
    agentBusy=true;
    try {
      const verified=await agentCall(config,'/connection/verify',{});
      if (!verified?.paired) throw Error('未能验证已配对的 Mac');
      await saveNativeConnection(config);
      agentConfig=config;
      persistAgentConfig(config);
      await refreshAgentConnection();
      void reviewAll();
      notice('已更新 Mac 地址');
    } catch(error) {notice(error.message||'更新地址失败');}
    finally {agentBusy=false;render();}
    return;
  }
  if (formElement.id==='pair-form') {
    agentBusy=true;
    render();
    try {
      const config={baseURL:String(form.get('baseURL')).trim().replace(/\/$/,''),fingerprint:String(form.get('fingerprint')).trim().replace(/[^a-fA-F0-9]/g,'').toUpperCase()};
      const result=await agentCall(config,'/pair',{code:String(form.get('code')).trim()});
      agentConfig={...config,token:result.token};
      agentConnection={status:'ready',error:''};
      persistAgentConfig(agentConfig);
      await saveNativeConnection(agentConfig);
      void reviewAll();
      notice('已连接 Along，之后会自动恢复');
    } catch(error) { notice(error.message || 'Along 请求失败'); }
    finally { agentBusy=false;render(); }
    return;
  }

  const message=String(form.get('message')).trim();
  if (!message) return;
  void enableAgentNotifications();
  const goalKey=activeGoal;
  const domain=goalDomain(goalKey);
  const history=conversations[goalKey]||[];
  const goal=currentGoal();
  const userEntry={role:'user',text:message};
  const pendingId=newId('pending');
  agentBusy=true;
  conversations[goalKey]=[...history,userEntry].slice(-20);
  saveConversations();
  const messages=app.querySelector('.agent-messages');
  messages?.querySelector('.agent-empty')?.remove();
  messages?.insertAdjacentHTML('beforeend',agentMessage(userEntry,goal,domain));
  messages?.insertAdjacentHTML('beforeend',agentPending(pendingId));
  formElement.querySelector('textarea')?.blur();
  formElement.reset();
  const textarea=formElement.querySelector('textarea');
  if (textarea) textarea.style.height='auto';
  setAgentComposerBusy(true);
  scrollAgentConversationToBottom();
  try {
    await submitSuperAgentGoal(goalKey,message,history.filter(item=>!item.localOnly).map(item=>({role:item.role,text:item.text})));
  } catch(error) {
    notice(error.message || 'Along 请求失败');
  } finally {
    agentBusy=false;
    if (screen==='agent' && activeGoal===goalKey) {
      renderAgentUpdate({follow:true});
    } else render();
  }
});
function legacyGoalIntent(key) {
  const history=conversations[key]||[];
  return history.filter(entry=>entry.role==='user'&&!entry.localOnly).map(entry=>entry.text).join('\n').slice(-1600);
}
function offersHealthSource(key) {
  if (!isCustomGoalKey(key)||(!goalCustom[key]&&!goalLayouts[key])) return false;
  const layout=goalLayouts[key];
  return (layout?.connections||[]).some(c=>/healthkit|apple.?health|苹果健康/i.test(c.id+' '+c.name))
    || /健康|睡眠|作息|运动|锻炼|健身|跑步|跑马|马拉松|步数|体重|睡觉|起床|workout|fitness|sleep|exercise|health/i.test(
      [goalCustom[key]?.title,goalCustom[key]?.intent,layout?.title,legacyGoalIntent(key)].join(' '));
}
const healthTypeLabels={steps:'步数',workout:'健身',sleep:'睡眠',weight:'体重',activeEnergy:'活动能量',restingHeartRate:'静息心率',wristTemperature:'手腕温度'};
function localHealthViewState() {
  if (state.source!=='healthkit'||!Array.isArray(goalCustom.health?.healthTypes)) return state;
  if (!hasHealthSource('health')) return {...state,source:null,snapshot:null};
  return {...state,snapshot:{...state.snapshot,selectedTypes:state.snapshot.selectedTypes?.filter(type=>goalCustom.health.healthTypes.includes(type))||[]}};
}
function healthConnection(key) {
  const summary=isCustomGoalKey(key)&&hasHealthSource(key)&&state.source==='healthkit'
    ? {...state,snapshot:scopedSnapshot(key)}:localHealthViewState();
  const source=healthView(summary).connection;
  const approved=nativeHealthStatus==='available'&&state.source==='healthkit'&&state.snapshot?.contextReviewAllowed===true;
  if (!hasHealthSource(key)) {
    const names=(state.snapshot?.selectedTypes||[]).map(t=>healthTypeLabels[t]).filter(Boolean);
    const includesComparison=state.snapshot?.comparisonHistoryAllowed&&(state.snapshot.selectedTypes||[]).some(t=>t==='sleep'||t==='weight');
    return {name:'Apple Health',label:'待关联',kind:'none',actionId:'link-goal-health',
      detail:approved?`使用${names.join('、')}的汇总${includesComparison?'（含已选睡眠或体重的近两周对比）':''}，在已配对的 Mac 上评估此目标的任务。`:'选择用于此目标任务评估的健康摘要。',
      action:approved?'允许此目标使用所选摘要':'连接 Apple Health'};
  }
  if (nativeHealthStatus==='unlinked') return {name:'Apple Health',label:'未连接',kind:'none',actionId:'connect-health',action:'连接',detail:'在 iPhone 上选择用于任务评估的数据。'};
  if (state.source==='healthkit'&&nativeHealthStatus==='available'&&!approved)
    return {...source,actionId:'connect-health',action:'启用任务评估',detail:`${source.detail}。允许 Agent 评估后，将按所选摘要复查任务。`};
  if (state.source==='healthkit'&&nativeHealthStatus!=='available')
    return {...source,label:'本机缓存',kind:'none',actionId:'connect-health',detail:'正在等待 iPhone 当前的读取结果。'};
  if (approved&&state.snapshot.backgroundReviewAllowed===true&&state.snapshot.backgroundReviewGoalKey===key&&agentRuntime===DSH_RUNTIME)
    return {...source,detail:source.detail.replace('前台自动检查','已允许后台评估'),actionId:'connect-health'};
  return {...source,actionId:'connect-health'};
}
function bindHealthSource(key,startReview=true) {
  if (state.source!=='healthkit'||!state.snapshot?.contextReviewAllowed||!Array.isArray(state.snapshot.selectedTypes)) return;
  goalCustom[key]={...goalCustom[key],healthTypes:[...state.snapshot.selectedTypes],
    comparisonHistoryAllowed:state.snapshot.comparisonHistoryAllowed===true};
  saveGoalCustom();
  render();
  if (startReview) void reviewFor(key).reviewHealthContext('feedback');
}
function scopedSnapshot(key,snapshot=state.source==='healthkit'?state.snapshot:null) {
  if (nativeHealthStatus!=='available'||!hasHealthSource(key)||!snapshot) return agentHealthSnapshot(null);
  const allowed=goalCustom[key]?.healthTypes;
  const comparisonHistoryAllowed=goalCustom[key]?.comparisonHistoryAllowed===true&&snapshot.comparisonHistoryAllowed===true;
  return agentHealthSnapshot({...snapshot,comparisonHistoryAllowed,
    selectedTypes:Array.isArray(allowed)?(snapshot.selectedTypes||[]).filter(type=>allowed.includes(type)):snapshot.selectedTypes});
}
function reviewAll(cause='observation',previous=null) {
  return Promise.all(healthGoalKeys().map(key=>reviewFor(key).reviewHealthContext(cause,previous?scopedSnapshot(key,previous):null)));
}
// Older iOS versions persisted the bridge's localized network error without a code.
// Match transport failures narrowly; a rejected model response remains a manual retry.
function localConnectionError(message) {
  if (typeof message!=='string') return false;
  if (/^(?:代理未能连接到 Mac|iPhone 未能验证 Mac 的安全连接|连接 Mac 失败)。/.test(message)) return true;
  return /kCFErrorDomainCFNetwork\s+(?:error\s+|Code=)310\b|到 Mac 的安全连接|网络连接.*(中断|丢失|断开)|未能连接到服务器|无法连接到服务器|未连接到互联网|网络似乎已断开|请求超时|network connection was lost|not connected to the internet|could not connect to the server|couldn.t connect to the server|request timed out|secure connection could not be established|NSURLErrorDomain.*-(?:1001|1004|1005|1009|1200)\b/i.test(message);
}
function moduleReviewText(module) {
  if (module.kind==='summary') return module.content;
  if (module.kind==='chips') return module.items.join('、');
  if (module.kind==='fact_list') return module.items.map(item=>`${item.label}：${item.value}`).join('；');
  if (module.kind==='metric') return [module.target,module.unit,module.note].filter(v=>v!=null&&v!=='').join(' ');
  return '';
}
// Interpret only an explicitly weekly exercise duration in approved plan text.
// Counts, sleep, a multi-week horizon and minutes already recorded are different facts.
function weeklyExerciseEvidence(text) {
  const values=[];
  const week=/每(?:一|个)?周|每星期|每礼拜|本周|(?<![0-9一二三四五六七八九十])周(?:累计|目标|运动|锻炼|训练|健身|有氧)|(?:分钟|分)\s*[/／]\s*周/;
  const exercise=/运动|锻炼|有氧|健身|训练|中等强度活动/;
  const duration=/([0-9]+(?:\.[0-9]+)?)\s*(分钟|小时)/g;
  let ambiguous=false;
  for (const line of String(text||'').split(/[。！？!?；;\n，,]/)) {
    if (!week.test(line)||!exercise.test(line)||!/[0-9]\s*(分钟|小时)/.test(line)) continue;
    if (/已(?:经)?(?:累计|完成|运动|锻炼)|实际|读数|记录显示|比上周|过去|还差|剩余|每次|每天|单次|睡眠|午睡|休息|通勤|用餐/.test(line)) continue;
    if (/本周/.test(line)&&!/目标|希望|至少|计划|争取|安排|力争|应达|需达|拟/.test(line)) continue;
    if (/[0-9]\s*(?:[-—–~～至到或]|或者)\s*[0-9]|[0-9]\s*(?:分钟|小时)\s*(?:至|到|或)/.test(line)) {ambiguous=true;continue;}
    const times=[...line.matchAll(duration)];
    if (times.length!==1) {ambiguous=true;continue;}
    const minutes=Number(times[0][1])*(times[0][2]==='小时'?60:1);
    if (Number.isInteger(minutes)&&minutes>0&&minutes<=10080) values.push(minutes);
    else ambiguous=true;
  }
  return {values,ambiguous};
}
function canGiveTaskInstruction(key) {
  return hasHealthSource(key)&&!!agentConfig.token&&nativeHealthStatus==='available'&&
    state.source==='healthkit'&&state.snapshot?.contextReviewAllowed===true&&scopedSnapshot(key).selectedTypes.length>0;
}
let activeAccessPreview=null;
function openReviewAccess(key) {
  if (!hasHealthSource(key)) return;
  const review=reviewFor(key),options=review.accessOptions();
  if (!options.length) return;
  activeAccessPreview={key,options,scope:review.sharing.scope||0};
  const boxes=options.map(option=>`<label><input type="checkbox" name="allow-${esc(option.key)}" ${option.checked?'checked':''}> ${esc(option.label)}</label>
    <details><summary>预览内容</summary><p>${esc(option.text)}</p></details>`).join('');
  if (sheet.open) sheet.close();
  show(`<div class="sheet-head"><h2>此目标的评估内容</h2><button class="icon-button" data-action="close" aria-label="关闭">×</button></div>
    <p class="sheet-copy">勾选的内容将随本目标的健康评估发给已配对的 Mac。选择会保存在本机，可以随时取消。</p>
    <form id="review-access-form">${boxes}<button class="button sheet-main-button">保存并重新评估</button></form>`);
}
sheet.addEventListener('submit',event=>{
  if (event.target.id==='task-instruction-form') {
    event.preventDefault();
    if (event.target.dataset.goal!==activeGoal||!canGiveTaskInstruction(activeGoal)) {
      sheet.close();notice('目标或授权已变化，请重新打开当前任务');return;
    }
    const instruction=String(new FormData(event.target).get('instruction')||'').trim().slice(0,300);
    if (!instruction) return;
    sheet.close();void enableAgentNotifications();reviewFor(activeGoal).instruct(instruction);
    return;
  }
  if (event.target.id!=='review-access-form') return;
  event.preventDefault();
  const preview=activeAccessPreview;
  if (!preview||preview.key!==activeGoal||!hasHealthSource(activeGoal)) {sheet.close();return;}
  const review=reviewFor(activeGoal);
  if ((review.sharing.scope||0)!==preview.scope||JSON.stringify(preview.options)!==JSON.stringify(review.accessOptions())) {
    openReviewAccess(activeGoal);notice('计划或授权已变化，请重新核对');return;
  }
  const form=new FormData(event.target);
  const selected=preview.options.filter(option=>form.get('allow-'+option.key)!=null);
  const instructionLength=selected.filter(o=>o.key==='title'||o.key==='intent'||o.key.startsWith('module-')).map(o=>o.text).join('\n').length;
  if (instructionLength>1550) {notice('请缩短所选目标要求，或减少本次使用的模块');return;}
  activeAccessPreview=null;sheet.close();
  review.setAccess(selected);
});
function createHealthReview(goalKey) {
  const planningKey=scopedKey(PLANNING_STATE_KEY,goalKey);
  const sharingKey=scopedKey(HEALTH_SHARING_KEY,goalKey);
  const ticketKey=scopedKey(TICKET_KEY,goalKey);
  let pendingTask=readStored(ticketKey,null);
  function saveTicket(ticket) {
    pendingTask=ticket;
    if (ticket) localStorage.setItem(ticketKey,JSON.stringify(ticket));
    else localStorage.removeItem(ticketKey);
    queueBackgroundSync();
  }
  let planningState=readStored(planningKey,{});
  if (!planningState||typeof planningState!=='object'||Array.isArray(planningState)) planningState={};
  if (planningState.run?.actual!==true&&planningState.run?.status==='working'&&planningState.nativeRequestId!==planningState.run.requestId) planningState={...planningState,
    run:{...planningState.run,status:'blocked',statusLabel:'需要重试',error:'上次情境评估未收到运行记录'}};
  let planningBusy=false,lastNativeReconnectProbe=0;
  function canRecoverConnection() {
    const {run,request,dismissedRequest,recoveredRequestId}=planningState;
    if (request&&planningState.nativeRequestId===request.requestId&&run?.requestId===request.requestId)
      return run.status==='blocked'&&dismissedRequest!==run.requestId&&localConnectionError(run.error);
    if (!request||!run||run.status!=='blocked'||run.actual!==false||run.runtime!==agentRuntime||
        run.requestId!==request.requestId||dismissedRequest===run.requestId||recoveredRequestId===run.requestId) return false;
    return run.error==='上次情境评估未收到运行记录'||localConnectionError(run.error);
  }
  function savePlanning(next) { planningState=next;localStorage.setItem(planningKey,JSON.stringify(next));queueBackgroundSync(); }
  let healthSharing=readStored(sharingKey,{});
  function saveHealthSharing(next) {
    healthSharing=next;
    localStorage.setItem(sharingKey,JSON.stringify(next));queueBackgroundSync();
  }
  function recordPlanningFeedback(feedback,reason=pendingTask?.reason) {
    if (!pendingTask?.requestId) return;
    savePlanning({...planningState,dismissedRequest:pendingTask.requestId,
      recentDecisions:[...(planningState.recentDecisions||[]),{at:new Date().toISOString(),decision:'feedback',reason,feedback}].slice(-6)});
  }
  function accessOptions() {
    const options=[];
    const add=(key,label,text,value=text)=>{
      if (text) options.push({key,label,text,value,checked:healthSharing.reviewAccess?.[key]===value});
    };
    if (healthSharing.localGoalTitle) {
      add('title','目标标题',currentGoal(goalKey).title);
      add('intent','已保存的目标要求',goalCustom[goalKey]?.intent);
    }
    const plan=localHealthPlan();
    if (healthSharing.localPlanText) {
      add('summary','计划摘要',plan.summary);
      for (const module of plan.modules||[]) {
        const text=moduleReviewText(module);
        if (text) add('module-'+module.id,module.title,module.title+'：'+text);
      }
    }
    for (const saved of healthSharing.tasks||[]) {
      const task=plan.tasks.find(t=>t.id===saved.id);
      if (!saved.localText||!task) continue;
      const fields=[task.title,task.detail,task.when,task.state,task.kind,task.scheduledFor];
      add('task-'+saved.alias,'任务 · '+task.title,fields.filter(Boolean).join(' · '),JSON.stringify(fields));
    }
    return options;
  }
  function reviewFields() {
    return Object.fromEntries(accessOptions().filter(option=>option.checked).map(option=>[option.key,option.text]));
  }
  function reviewTitle(fields) { return healthSharing.localGoalTitle?fields.title||'我的健康目标':currentGoal(goalKey).title; }
  function healthGoalIntent(fields=reviewFields()) {
    const intent=healthSharing.localGoalTitle?fields.intent:goalCustom[goalKey]?.intent||legacyGoalIntent(goalKey);
    const constraints=Object.entries(fields).filter(([key])=>key.startsWith('module-')).map(([,text])=>text);
    return [reviewTitle(fields),intent,...constraints].filter(Boolean).join('\n').trim().slice(0,1600);
  }
  function workoutTarget(local=false,fields=reviewFields()) {
    if (goalKey!=='health') return null;
    const goal=currentGoal(goalKey),plan=goalLayouts[goalKey];
    const title=local?goal.title:reviewTitle(fields);
    const intent=local?goalCustom[goalKey]?.intent:healthSharing.localGoalTitle?fields.intent:goalCustom[goalKey]?.intent;
    const selectedPlan=local?localHealthPlan():currentHealthPlan(fields);
    const statements=[title,intent,selectedPlan.summary];
    for (const task of selectedPlan.tasks) {
      statements.push(task.title,task.detail);
      // An adopted task can put its duration in the title and its weekly
      // cadence in a separate field. Demand an explicit current/weekly target.
      if (/(?:目标|至少|计划|力争|争取)/.test(task.title)&&
          (/^(本周|每周)$/.test(task.when)||/(?:每周|本周|周运动)的?(?:运动|锻炼|训练|健身)?(?:目标|计划)/.test(task.detail)))
        statements.push('每周'+task.title);
    }
    const values=new Set();
    for (const statement of statements) {
      const evidence=weeklyExerciseEvidence(statement);
      if (evidence.ambiguous) return null;
      for (const value of evidence.values) values.add(value);
    }
    for (const m of plan?.modules||[]) {
      if (m.kind!=='metric'||m.source!=='workoutMinutes'||!(/每周|本周|周累计|一周/.test([m.title,m.note,m.unit].join(''))&&/分钟/.test(m.unit))) continue;
      if (!local&&healthSharing.localPlanText&&!Object.hasOwn(fields,'module-'+m.id)) continue;
      const n=Number(m.target);
      if (Number.isInteger(n)&&n>0&&n<=10080) values.add(n);
    }
    if (values.size) return values.size===1?[...values][0]:null;
    return !goalCustom[goalKey]?.title&&!plan&&(local||!healthSharing.localGoalTitle)?goal.target:null;
  }
  function latestDecision() {
    const saved=planningState.lastDecision;
    if (saved?.reply) return saved;
    // Upgrade an already validated result from Build 45. A host run by itself
    // is insufficient: it must also have been accepted into the local decision log.
    const run=planningState.run,a=run?.result?.reassessment;
    if (!a) return saved||null;
    const logged=(planningState.recentDecisions||[]).slice().reverse().find(d=>d.decision===a.decision&&d.reason===a.reason);
    if (!run?.actual||run.status!=='done'||!logged||!planningState.evaluated||a.basedOnRevision!==run.requestId||
      planningState.request?.requestId!==run.requestId||saved&&saved.requestId!==run.requestId) return saved||null;
    return {decision:a.decision,reason:a.reason,at:logged.at,runtime:run.runtime,requestId:run.requestId,
      reply:typeof run.result.reply==='string'?run.result.reply.trim().slice(0,1200):''};
  }
  function setAccess(selected) {
    const grants=Object.fromEntries(selected.map(o=>[o.key,o.value]));
    if (JSON.stringify(grants)===JSON.stringify(healthSharing.reviewAccess||{})) return;
    if (Object.keys(healthSharing.reviewAccess||{}).some(key=>!Object.hasOwn(grants,key))) revokeDaily();
    const scope=(healthSharing.scope||0)+1;
    saveHealthSharing({...healthSharing,scope,reviewAccess:grants});
    // Old request bodies, reasons and feedback can quote a newly withheld task.
    // A late asynchronous reply must no longer find its request id here.
    savePlanning({lastDecision:latestDecision(),queued:true});
    saveTicket(null);render();
    void reviewHealthContext('feedback');
  }
  function localHealthPlan() {
    if (goalLayouts[goalKey]) return goalLayouts[goalKey];
    const model=goalKey==='health'?healthView(localHealthViewState(),goalCustom.health):customView(goalKey);
    return {title:currentGoal(goalKey).title,summary:model.note,tasks:[model.primary,...model.secondary].map((t,i)=>({
      id:i===0?'primary':`follow-up-${i-1}`,when:t.status||'之后',title:t.title,detail:t.detail,state:i===0?'planned':'deferred'}))};
  }
  function shareableHealthTask(task) {
    const saved=healthSharing.tasks?.find(t=>t.id===task.id);
    if (!saved) return task;
    if (!saved.localText) return {...task,id:saved.alias};
    return {id:saved.alias,when:'已安排',title:'本机保留的任务',detail:'任务内容来自旧授权范围，请保留。',state:task.state};
  }
  function currentHealthPlan(fields=reviewFields()) {
    const plan=localHealthPlan();
    const tasks=plan.tasks.map(task=>{
      const saved=healthSharing.tasks?.find(t=>t.id===task.id);
      return saved&&Object.hasOwn(fields,'task-'+saved.alias)?{...task,id:saved.alias}:shareableHealthTask(task);
    });
    return healthSharing.localPlanText?{title:reviewTitle(fields),summary:fields.summary||'旧计划的详情仅保存在本机。',tasks}:{...plan,tasks};
  }
  function protectedTaskIds(fields) {
    const currentIds=new Set(localHealthPlan().tasks.map(t=>t.id));
    return (healthSharing.tasks||[]).filter(t=>currentIds.has(t.id)&&t.localText&&!Object.hasOwn(fields,'task-'+t.alias)).map(t=>t.alias);
  }
  function dailyDelegation() {
    const grant=cleanDailyDelegation(healthSharing.dailyDelegation);
    if (!grant||grant.goalKey!==goalKey||!hasHealthSource(goalKey)||!agentConfig.token||agentRuntime!==DSH_RUNTIME||
        !healthSharing.dailyRecipient||healthSharing.dailyRecipient!==agentConfig.fingerprint||state.loop?.experiment===EXPERIMENT||
        nativeHealthStatus==='unlinked'||state.source!=='healthkit'||state.snapshot?.contextReviewAllowed!==true) return null;
    // Display can use the last approved local category list while a locked
    // phone cannot read new observations. Submission and claiming still need
    // fresh native availability. Explicit withdrawal clears this grant.
    const allowed=goalCustom[goalKey]?.healthTypes;
    return grant.topics.every(t=>state.snapshot.selectedTypes?.includes(t)&&(!Array.isArray(allowed)||allowed.includes(t)))?grant:null;
  }
  function dailyReceipt(run,grant) {
    const p=run?.input?.snapshot?.planning;
    if (!grant||!p||run?.actual!==true||run.kind!=='goal'||run.runtime!==DSH_RUNTIME||run.status!=='done'||
        typeof run.ticket?.id!=='string'||!run.ticket.id||typeof run.requestId!=='string'||run.requestId!==p.revisionId||
        run.input.goal?.domain!==goalDomain(goalKey)||run.result?.proposal!=null||run.result?.reassessment?.basedOnRevision!==run.requestId||
        JSON.stringify(cleanDailyDelegation(p.dailyDelegation))!==JSON.stringify(grant)) return null;
    const snapshot=run.input.snapshot,scope=scopedSnapshot(goalKey);
    if (snapshot.contextReviewAllowed!==true||!Array.isArray(snapshot.selectedTypes)||
        !grant.topics.every(t=>snapshot.selectedTypes.includes(t))||snapshot.selectedTypes.some(t=>!scope.selectedTypes.includes(t))||
        snapshot.comparisonHistoryAllowed===true&&!scope.comparisonHistoryAllowed||
        (p.previous?.selectedTypes||[]).some(t=>!scope.selectedTypes.includes(t))||
        p.previous?.comparisonHistoryAllowed===true&&!scope.comparisonHistoryAllowed) return null;
    try {
      const assessment=validateReassessment(run.result.reassessment,run.result.layout,p);
      const action=validateDailyActions(assessment.dailyActions,p);
      return {action:{...action,timezone:p.timezone,evaluatedAt:p.now,delegationId:grant.id,runtime:run.runtime,
        requestId:run.requestId,ticketId:run.ticket.id},evidence:agentHealthSnapshot(snapshot)};
    } catch { return null; }
  }
  function todayActions() {
    const grant=dailyDelegation(),saved=planningState.dailyRecord?.action;
    const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!grant||saved?.delegationId!==grant.id||saved.runtime!==DSH_RUNTIME||!saved.ticketId||!saved.requestId||
        saved.timezone!==timezone||saved.localDate!==new Intl.DateTimeFormat('en-CA',{timeZone:timezone}).format(new Date())) return null;
    return saved;
  }
  function needsDailyReview(after) {
    return !!dailyDelegation()&&(!todayActions()||healthContextChanges(planningState.dailyRecord?.evidence,after).length>0);
  }
  function claimDailyDelegation(value,raw) {
    const grant=cleanDailyDelegation(value),run=safeGoalSuperAgentRun(raw);
    if (!nativeObservationSeen||!canGiveTaskInstruction(goalKey)||agentRuntime!==DSH_RUNTIME||state.loop?.experiment===EXPERIMENT||
        !grant||grant.goalKey!==goalKey||value.requestId!==run?.requestId||value.ticketId!==run?.ticket?.id||
        healthSharing.dailyDelegation&&dailyDelegation()?.id!==grant.id) return false;
    const receipt=dailyReceipt(run,grant);
    if (!receipt||healthSharing.dailyRevokedIds?.includes(grant.id)||Date.parse(receipt.action.evaluatedAt)>Date.now()||
        Date.parse(receipt.action.evaluatedAt)<=(healthSharing.dailyRevokedAt||0)) return false;
    if (planningState.dailyRecord?.action?.delegationId===grant.id&&Date.parse(planningState.dailyRecord.action.evaluatedAt)>Date.parse(receipt.action.evaluatedAt)) return true;
    saveHealthSharing({...healthSharing,dailyDelegation:grant,dailyRecipient:agentConfig.fingerprint});
    const previous=planningState;
    // A Mac handoff acknowledges this daily instruction only. Preserve an
    // unrelated pending adopt/reject proposal or working health review.
    savePlanning({...previous,dailyRecord:receipt});
    if (!previous.evaluated&&!previous.request&&!pendingTask) savePlanning({...planningState,evaluated:receipt.evidence,
      localDate:receipt.action.localDate,goalIntent:healthGoalIntent()});
    if (needsDailyReview(scopedSnapshot(goalKey))&&!pendingTask) void reviewHealthContext();
    return true;
  }
  function revokeDaily() {
    const old=healthSharing.dailyDelegation?.id;
    const revoked=healthSharing.dailyRevokedIds||[];
    const next={...healthSharing,dailyRevokedAt:Date.now(),dailyRevokedIds:old?[...new Set([...revoked,old])].slice(-32):revoked};
    delete next.dailyDelegation;delete next.dailyRecipient;
    saveHealthSharing(next);
    const {dailyRecord,...saved}=planningState;
    if (saved.request?.snapshot?.planning?.dailyDelegation) {
      if (pendingTask?.requestId===saved.request.requestId&&pendingTask.status!=='proposed') saveTicket(null);
      Object.assign(saved,{request:null,run:null,nativeRequestId:null,nativeVersion:null,uncertainNativeReceipt:false});
    }
    savePlanning(saved);
    cancelDailyAgenda(goalKey);
  }
  function applyDailyInstruction(feedback) {
    // Full imperative matches only. A question, tentative suggestion, quoted
    // sentence, once-only request or reference to reading health data gives no grant.
    const command=feedback.trim().replace(/[。！!]$/u,'');
    const stop=/^(?:请)?(?:停止|取消|关闭|暂停|不要再)(?:我的)?(?:每天|每日)(?:的)?(?:任务)?提醒$/.test(command);
    const starting=command.match(/^(?:请)?(?:从今天起|从今天开始|以后)?(?:每天|每日)(?:都)?(?:帮我)?(?:安排并)?提醒我(睡觉|就寝|运动)(?:和(睡觉|就寝|运动))?$/u);
    const stopping=command.match(/^(?:请)?(?:停止|取消|关闭|暂停)(?:每天|每日)(?:的)?(运动|就寝|睡觉|睡前)提醒$/u)||
      command.match(/^(?:请)?(?:不要|别|不要再|别再|停止|取消|暂停)(?:每天|每日)(?:都)?提醒我(运动|就寝|睡觉|睡前)(?:和(运动|就寝|睡觉|睡前))?$/u);
    if (stop) {revokeDaily();return;}
    const toTopic=word=>word==='运动'?'workout':'sleep';
    const old=dailyDelegation();
    if (stopping) {
      revokeDaily();
      if (!old) return;
      const removed=stopping.slice(1).filter(Boolean).map(toTopic);
      const topics=old.topics.filter(t=>!removed.includes(t));
      if (topics.length) saveHealthSharing({...healthSharing,dailyRecipient:agentConfig.fingerprint,
        dailyDelegation:cleanDailyDelegation({id:newId('daily'),goalKey,topics,weeklyWorkoutMinutes:topics.includes('workout')?old.weeklyWorkoutMinutes:null})});
      return;
    }
    if (!starting||agentRuntime!==DSH_RUNTIME||!canGiveTaskInstruction(goalKey)) return;
    const topics=[...new Set([...(old?.topics||[]),...starting.slice(1).filter(Boolean).map(toTopic)])].sort();
    if (!topics.every(t=>scopedSnapshot(goalKey).selectedTypes.includes(t))||JSON.stringify(topics)===JSON.stringify(old?.topics)) return;
    if (old) revokeDaily();
    saveHealthSharing({...healthSharing,dailyRecipient:agentConfig.fingerprint,
      dailyDelegation:cleanDailyDelegation({id:newId('daily'),goalKey,topics,weeklyWorkoutMinutes:topics.includes('workout')?workoutTarget():null})});
  }
  function includesInstruction(request) {
    const instruction=planningState.instruction;
    return !instruction||request?.snapshot?.planning?.recentDecisions?.some(d=>d.at===instruction.at&&d.feedback===instruction.feedback);
  }
  function instruct(feedback) {
    applyDailyInstruction(feedback);
    const instruction={at:new Date().toISOString(),decision:'feedback',feedback};
    savePlanning({...planningState,instruction,queued:true,recentDecisions:[...(planningState.recentDecisions||[]),instruction].slice(-6)});
    if (pendingTask?.status!=='assigned') saveTicket(null);
    void reviewHealthContext('feedback');
    if (screen==='home') render();
  }
  function awaitingEarlierProposal() {
    return pendingTask?.status==='proposed'&&!!dailyDelegation();
  }
  function retainEarlierProposal() {
    if (!awaitingEarlierProposal()) return false;
    if (!pendingTask.originalRequest&&planningState.request?.requestId===pendingTask.requestId)
      saveTicket({...pendingTask,originalRequest:planningState.request});
    return true;
  }
  function backgroundTemplate() {
    const fields=reviewFields(),after=scopedSnapshot(goalKey);
    const weeklyWorkoutMinutes=workoutTarget(false,fields);
    const goal={domain:goalDomain(goalKey),title:reviewTitle(fields),target:weeklyWorkoutMinutes};
    const previous=planningState.evaluated||after;
    const planning=cleanPlanningContext({version:1,dailyDelegation:dailyDelegation(),goalIntent:healthGoalIntent(fields),weeklyWorkoutMinutes,
      protectedTaskIds:protectedTaskIds(fields),currentPlan:currentHealthPlan(fields),recentDecisions:planningState.recentDecisions,
      previous:{...previous,selectedTypes:(previous.selectedTypes||[]).filter(type=>after.selectedTypes.includes(type)),
        comparisonHistoryAllowed:previous.comparisonHistoryAllowed===true&&after.comparisonHistoryAllowed===true}});
    // Do not hash/serialize local-only text or the pairing token. The native version
    // covers the precise approved plan and the recipient, independently of sample time.
    const {previous:ignored,...policy}=planning;
    const identity=JSON.stringify([goalKey,healthSharing.scope||0,agentConfig.fingerprint,goal,policy,after.selectedTypes,after.comparisonHistoryAllowed]);
    let stored=readStored(BG_TEMPLATE_KEY,null);
    if (!stored||stored.identity!==identity) {
      stored={identity,version:newId('bg-scope')};
      localStorage.setItem(BG_TEMPLATE_KEY,JSON.stringify(stored));
    }
    return {goalKey,version:stored.version,runtime:DSH_RUNTIME,goal,planning,selectedTypes:after.selectedTypes,
      comparisonHistoryAllowed:after.comparisonHistoryAllowed===true,
      evaluatedLocalDate:planning.dailyDelegation?(planningState.dailyRecord?.action?.localDate||null):(planningState.localDate||null),nextReviewAt:planningState.nextReviewAt||null,
      paused:!!pendingTask&&!awaitingEarlierProposal()||planningState.run?.status==='working'||!!planningState.instruction};
  }
  function retireNative(template) {
    const {request,nativeRequestId,nativeVersion}=planningState;
    if (!nativeRequestId||nativeRequestId!==request?.requestId||
        template?.goalKey===goalKey&&template.version===nativeVersion) return;
    // A response to this ID must not be polled, re-posted or applied after
    // withdrawing its goal, pairing, task text or HealthKit category scope.
    savePlanning({...planningState,request:null,run:null,nativeRequestId:null,nativeVersion:null,uncertainNativeReceipt:false});
    if (pendingTask?.requestId===nativeRequestId) saveTicket(null);
  }
  function claimBackground(receipt,template) {
    const request=receipt.request,id=receipt.requestId;
    if (!id||request?.requestId!==id||request.runtime!==DSH_RUNTIME||!['accepted','uncertain'].includes(receipt.state)) return false;
    if (planningState.request?.requestId===id) {
      if (receipt.state==='accepted'&&planningState.uncertainNativeReceipt) savePlanning({...planningState,uncertainNativeReceipt:false});
      return true;
    }
    if (planningBusy||planningState.run?.status==='working'||pendingTask&&!awaitingEarlierProposal()||planningState.instruction) return false;
    const p=request.snapshot?.planning;
    let basis=template;
    if (receipt.previousRequestId!=null) {
      const baseline=receipt.baseline;
      if (typeof receipt.previousRequestId!=='string'||!/^along-review-[A-Za-z0-9_-]+$/.test(receipt.previousRequestId)||receipt.previousRequestId===id||
          baseline?.contextReviewAllowed!==true||!Array.isArray(baseline.selectedTypes)||!baseline.selectedTypes.length||
          baseline.selectedTypes.some(type=>!template.selectedTypes.includes(type))||
          baseline.comparisonHistoryAllowed===true&&!template.comparisonHistoryAllowed) return false;
      // Native verified the previous run's ticket in this same goal/consent
      // generation. Only its allowed health facts can advance the baseline.
      basis={...template,evaluatedLocalDate:receipt.evaluatedLocalDate,nextReviewAt:receipt.nextReviewAt,
        planning:{...template.planning,previous:agentHealthSnapshot(baseline)}};
    }
    const previous=receipt.previousRequestId||planningState.evaluated?basis.planning.previous:p?.previous;
    const rebuilt=buildBackgroundReviewRequest({...basis,paused:false,planning:{...basis.planning,previous}},{...request.snapshot,backgroundReviewAllowed:true,backgroundReviewGoalKey:goalKey},
      id,{now:p?.now,timezone:p?.timezone,localDate:p?.localDate});
    if (!rebuilt||request.goal?.domain!==rebuilt.goal.domain||request.goal?.title!==rebuilt.goal.title||request.goal?.target!==rebuilt.goal.target||
        request.message!==rebuilt.message||!Array.isArray(request.history)||request.history.length||
        JSON.stringify(cleanPlanningContext(p))!==JSON.stringify(rebuilt.snapshot.planning)) return false;
    const keepProposal=retainEarlierProposal();
    const at=Date.now();
    const saved={...planningState,lastDecision:latestDecision(),request:rebuilt,queued:false,nativeVersion:template.version,
      nativeRequestId:id,uncertainNativeReceipt:receipt.state==='uncertain',run:createPendingGoalSuperAgentRun(rebuilt,at,DSH_RUNTIME)};
    // ACK follows the durable write. If storage fails, native retains ownership.
    localStorage.setItem(planningKey,JSON.stringify(saved));
    planningState=saved;
    if (!keepProposal) saveTicket({id,requestId:id,goalKey,source:'healthkit',status:'assigned',reason:'正在接回后台健康评估'});
    void refreshHealthReview();
    return true;
  }
  function planningResultIsCurrent(request) {
    const sentGrant=request.snapshot.planning.dailyDelegation;
    return (!sentGrant||JSON.stringify(cleanDailyDelegation(sentGrant))===JSON.stringify(dailyDelegation()))&&includesInstruction(request)&&nativeHealthStatus==='available'&&state.source==='healthkit'&&state.snapshot?.contextReviewAllowed===true&&healthGoalIntent()===request.snapshot.planning.goalIntent&&
      (request.snapshot.planning.weeklyWorkoutMinutes??null)===workoutTarget()&&
      JSON.stringify(request.snapshot.planning.protectedTaskIds||[])===JSON.stringify(protectedTaskIds(reviewFields()))&&
      healthContextChanges(request.snapshot,scopedSnapshot(goalKey)).length===0&&
      JSON.stringify(cleanPlanningContext({...request.snapshot.planning,currentPlan:currentHealthPlan()}).currentPlan)===JSON.stringify(request.snapshot.planning.currentPlan);
  }
  function consumeHealthReview(raw,request) {
    if (planningState.nativeRequestId===request.requestId) {
      if (document.visibilityState==='hidden'||!nativeObservationSeen||!nativeConnectionRestored) return;
      const template=currentBackgroundTemplate();
      if (template===undefined) return;
      retireNative(template);
      if (planningState.request?.requestId!==request.requestId) return;
    }
    const run=safeGoalSuperAgentRun(raw);
    if (!run?.actual||run.requestId!==request.requestId||run.runtime!==request.runtime) throw Error('Super Agent 没有返回该请求的真实评估记录');
    savePlanning({...planningState,run:{...run,createdAt:planningState.run?.createdAt||Date.now()}});
    if (run.status==='working') return;
    if (run.status==='blocked') {
      if (pendingTask?.requestId===request.requestId) saveTicket({...pendingTask,status:'waiting',error:run.error||run.statusLabel});
      return;
    }
    if (!planningResultIsCurrent(request)) {
      savePlanning({...planningState,queued:true});
      return;
    }
    const result=run.result;
    let layout=result?.layout?validateAdaptiveLayout(result.layout,goalDomain(goalKey)):null;
    const assessment=validateReassessment(result?.reassessment,layout,request.snapshot.planning);
    if (result?.proposal) throw Error('情境评估不能修改目标');
    const aliases=new Map((healthSharing.tasks||[]).map(t=>[t.alias,t]));
    if (layout&&aliases.size) {
      const originals=localHealthPlan().tasks;
      layout={...layout,tasks:layout.tasks.map(task=>{
        const saved=aliases.get(task.id);
        if (!saved) {
          if (healthSharing.tasks.some(t=>t.id===task.id)) throw Error('新任务与本机保留的任务编号冲突');
          return task;
        }
        const changed=assessment.changes.some(c=>c.taskId===task.id&&c.operation==='update');
        return changed?{...task,id:saved.id}:originals.find(t=>t.id===saved.id);
      })};
    }
    if (layout&&goalLayouts[goalKey]) layout={...goalLayouts[goalKey],tasks:layout.tasks};
    const at=new Date().toISOString();
    const daily=request.snapshot.planning.dailyDelegation?dailyReceipt(run,dailyDelegation()):null;
    if (request.snapshot.planning.dailyDelegation&&!daily) throw Error('未收到符合本目标每日委托的 DSH 评估回执');
    const updateDaily=daily&&!(Date.parse(planningState.dailyRecord?.action?.evaluatedAt)>Date.parse(daily.action.evaluatedAt));
    savePlanning({...planningState,...(updateDaily?{dailyRecord:daily}:{}),instruction:null,nativeRequestId:null,nativeVersion:null,uncertainNativeReceipt:false,lastDecision:{requestId:run.requestId,at,runtime:run.runtime,decision:assessment.decision,reason:assessment.reason,
      reply:typeof result.reply==='string'?result.reply.trim().slice(0,1200):''},
      evaluated:agentHealthSnapshot(request.snapshot),localDate:request.snapshot.planning.localDate,
      goalIntent:request.snapshot.planning.goalIntent,nextReviewAt:assessment.nextReviewAt,
      recentDecisions:[...(planningState.recentDecisions||[]),{at:new Date().toISOString(),decision:assessment.decision,reason:assessment.reason,watchFor:assessment.watchFor}].slice(-6)});
    if (planningState.dismissedRequest===request.requestId||pendingTask?.status==='proposed'&&pendingTask.requestId!==request.requestId&&daily) return;
    if (assessment.decision==='keep') {
      if (pendingTask?.requestId===request.requestId) saveTicket(null);
      return;
    }
    const localChanges=assessment.changes.map(c=>({...c,taskId:aliases.get(c.taskId)?.id||c.taskId}));
    const changed=localChanges.filter(c=>c.operation!=='keep');
    const userTask=layout?.tasks.find(t=>t.kind!=='agent_action'&&changed.some(c=>c.taskId===t.id));
    const removed=changed.find(c=>c.operation==='cancel');
    const oldTask=localHealthPlan().tasks.find(t=>t.id===removed?.taskId);
    const nextAction=userTask?.title||(oldTask?`取消「${oldTask.title}」`:'查看更新后的安排');
    const ticket={id:request.requestId,requestId:request.requestId,goalKey,source:'healthkit',status:'proposed',
      reason:assessment.reason,assessment:{...assessment,changes:localChanges},layout,
      suggestion:layout?{task:nextAction,reason:assessment.reason}:null,
      error:assessment.decision==='need_data'?result.reply:null};
    saveTicket(ticket);
    if (userTask||removed) void deliverAgentNotification(healthProposalNotification(ticket));
  }
  async function reviewHealthContext(cause='observation',before=null) {
    if (document.visibilityState==='hidden'||nativeHealthStatus!=='available'||!hasHealthSource(goalKey)||state.source!=='healthkit'||!state.snapshot?.contextReviewAllowed||state.loop?.experiment===EXPERIMENT||!agentConfig.token) return;
    if (window.AlongHealthBridge?.backgroundReview&&goalKey===activeGoal&&state.snapshot.backgroundReviewAllowed&&state.snapshot.backgroundReviewGoalKey===goalKey&&agentRuntime===DSH_RUNTIME) {
      // A native submission may have left the phone while this WebView was suspended.
      // Take ownership before creating any foreground request for the same observation.
      const template=currentBackgroundTemplate();
      if (!template||!await claimBackgroundReview(template)||document.visibilityState==='hidden'||currentBackgroundTemplate()?.version!==template.version) return;
    }
    if (planningState.nativeRequestId&&planningState.nativeRequestId===planningState.request?.requestId&&planningState.run?.status==='blocked') {
      if (cause==='retry'||verifiedHealthHost&&canRecoverConnection()) {
        savePlanning({...planningState,run:{...planningState.run,status:'working',error:null,createdAt:Date.now()}});
        if (pendingTask?.requestId===planningState.nativeRequestId) saveTicket({...pendingTask,status:'assigned',error:null});
        void refreshHealthReview();
      } else if (cause==='observation'&&!verifiedHealthHost&&canRecoverConnection()&&Date.now()-lastNativeReconnectProbe>15_000) {
        lastNativeReconnectProbe=Date.now();
        void refreshAgentConnection({healthOnly:true});
      }
      return;
    }
    if (planningBusy) {
      if (!planningState.request||!planningResultIsCurrent(planningState.request)) savePlanning({...planningState,queued:true});
      return;
    }
    if (planningState.run?.status==='working') {
      if (planningState.request&&!planningResultIsCurrent(planningState.request)) savePlanning({...planningState,queued:true});
      return;
    }
    const after=scopedSnapshot(goalKey);
    if (!after.selectedTypes.length) return;
    const localDate=new Intl.DateTimeFormat('en-CA').format(new Date());
    const recover=verifiedHealthHost&&canRecoverConnection();
    if (cause==='reconnect'&&!recover) return;
    const updateDaily=needsDailyReview(after);
    const changed=updateDaily||!includesInstruction(planningState.request)||(!planningState.request&&!planningState.lastDecision)||healthContextChanges(planningState.evaluated,after).length>0||healthGoalIntent()!==planningState.goalIntent;
    const due=planningState.nextReviewAt&&Date.parse(planningState.nextReviewAt)<=Date.now();
    if (!recover&&!['feedback','retry'].includes(cause)&&!changed&&!due&&planningState.localDate===localDate) return;
    // A failed run is retained for inspection; a new observation or context change
    // may start another, but the same failed request must not spin forever.
    if (!recover&&cause!=='retry'&&planningState.run?.status==='blocked'&&planningState.request&&planningResultIsCurrent(planningState.request)&&
        planningState.request.snapshot.planning.localDate===localDate&&(!updateDaily||planningState.request.snapshot.planning.dailyDelegation?.id===dailyDelegation()?.id)) return;
    const requestId=newId('along-review');
    const fields=reviewFields(),weeklyWorkoutMinutes=workoutTarget(false,fields);
    const previous=planningState.evaluated||(before&&healthContextChanges(before,after).length?before:null);
    const planning=createPlanningContext({before:previous,after,dailyDelegation:updateDaily?dailyDelegation():null,goalIntent:healthGoalIntent(fields),
      protectedTaskIds:protectedTaskIds(fields),weeklyWorkoutMinutes,currentPlan:currentHealthPlan(fields),recentDecisions:planningState.recentDecisions,cause:planningState.instruction?'feedback':due?'review':cause,revisionId:requestId});
    // Use the original idempotent submission only while its goal and observation match.
    const previousRequest=planningState.request;
    const resume=recover&&previousRequest.snapshot?.planning?.localDate===localDate&&planningResultIsCurrent(previousRequest);
    const request=resume?previousRequest:{...createGoalSuperAgentRequest({domain:goalDomain(goalKey),goal:{domain:goalDomain(goalKey),title:reviewTitle(fields),target:weeklyWorkoutMinutes},snapshot:{...after,planning},
      message:planningState.instruction?.feedback||'请结合目标、已有安排和最新情境，评估是否需要调整；给出判断与任务变更依据。',history:[],requestId}),runtime:agentRuntime};
    const keepProposal=updateDaily&&retainEarlierProposal();
    planningBusy=true;
    const submittedId=request.requestId;
    savePlanning({...planningState,lastDecision:latestDecision(),request,queued:false,recoveredRequestId:recover?submittedId:null,run:createPendingGoalSuperAgentRun(request,Date.now(),request.runtime)});
    if (!keepProposal) saveTicket({id:submittedId,requestId:submittedId,goalKey,source:'healthkit',status:'assigned',reason:'Super Agent 正在评估目标、最新情境与已有安排'});
    if (screen==='home'&&activeGoal===goalKey) render();
    try {
      const response=await agentCall(agentConfig,'/super-agent/goals',request);
      if (planningState.request?.requestId===submittedId) consumeHealthReview(response?.run,request);
    } catch(error) {
      if (planningState.request?.requestId===submittedId) {
        if (localConnectionError(error.message)) verifiedHealthHost=false;
        savePlanning({...planningState,run:createFailedGoalSuperAgentRun(request,error.message,Date.now(),request.runtime)});
        if (pendingTask?.requestId===submittedId) saveTicket({...pendingTask,status:'waiting',error:error.message});
      }
    } finally {
      planningBusy=false;
      if (screen==='home') render();
      if (planningState.queued&&planningState.run?.status!=='working') void reviewHealthContext();
    }
  }
  async function refreshHealthReview() {
    const {run,request}=planningState;
    if (document.visibilityState==='hidden'||nativeHealthStatus!=='available'||planningBusy||run?.status!=='working'||!request||!agentConfig.token) return;
    if (planningState.nativeRequestId===request.requestId) {
      if (!nativeObservationSeen||!nativeConnectionRestored) return;
      const template=currentBackgroundTemplate();
      if (template===undefined) return;
      retireNative(template);
      if (request.requestId!==planningState.request?.requestId) return;
    }
    planningBusy=true;
    try {
      const retryNative=planningState.nativeRequestId===request.requestId&&planningState.uncertainNativeReceipt&&planningResultIsCurrent(request);
      const latest=retryNative?(await agentCall(agentConfig,'/super-agent/goals',request))?.run:
        await agentCall(agentConfig,'/super-agent/goals/status',{requestId:request.requestId,runtime:request.runtime,contextReview:true});
      if (planningState.request?.requestId===request.requestId) {
        try {
          if (retryNative&&latest?.actual&&latest.requestId===request.requestId) savePlanning({...planningState,uncertainNativeReceipt:false});
          consumeHealthReview(latest,request);
        }
        catch(error) {
          savePlanning({...planningState,run:{...run,status:'blocked',error:error.message}});
          if (pendingTask?.requestId===request.requestId) saveTicket({...pendingTask,status:'waiting',error:error.message});
        }
        if (planningState.run?.status==='working'&&Date.now()-run.createdAt>AGENT_RUN_TIMEOUT_MS)
          savePlanning({...planningState,run:withRunError(planningState.run,'情境评估超时')});
      }
    } catch(error) {
      if (planningState.request?.requestId===request.requestId) {
        const interrupted=planningState.nativeRequestId===request.requestId&&localConnectionError(error.message);
        if (interrupted) verifiedHealthHost=false;
        const failed=interrupted?{...run,status:'blocked',error:error.message}:
          run.actual?withRunError(run,error.message):createFailedGoalSuperAgentRun(request,error.message,Date.now(),request.runtime);
        savePlanning({...planningState,run:failed});
        if (failed.status==='blocked'&&pendingTask?.requestId===request.requestId) saveTicket({...pendingTask,status:'waiting',error:failed.error});
      }
    } finally {
      planningBusy=false;
      if (screen==='home') render();
      if (planningState.queued&&planningState.run?.status!=='working') void reviewHealthContext();
    }
  }

  function clear() {
    revokeDaily();
    if (pendingTask?.source==='healthkit') saveTicket(null);
    planningState={};
    localStorage.removeItem(planningKey);
  }
  function restrict() {
    revokeDaily();
    const oldRuns=Object.entries(goalSuperAgentRuns).filter(([key,run])=>key.startsWith(goalKey+':')&&run.status==='working').map(([,run])=>run.requestId);
    saveHealthSharing({dailyRevokedAt:healthSharing.dailyRevokedAt,dailyRevokedIds:healthSharing.dailyRevokedIds,localGoalTitle:true,localPlanText:true,scope:(healthSharing.scope||0)+1,oldRuns:[...new Set([...(healthSharing.oldRuns||[]),...oldRuns])].slice(-20),
      tasks:localHealthPlan().tasks.map(task=>({id:task.id,alias:newId('private-task'),localText:true}))});
    conversations[goalKey]=(conversations[goalKey]||[]).map(entry=>({...entry,localOnly:true,proposal:null,layout:null}));
    saveConversations();
    planningState={};
    localStorage.removeItem(planningKey);
    if (pendingTask?.requestId) saveTicket(null);
  }
  function goalUpdated(item,validatedLayout) {
    if (healthSharing.dailyDelegation) revokeDaily();
    if (healthSharing.reviewAccess) {
      saveHealthSharing({...healthSharing,reviewAccess:{},scope:(healthSharing.scope||0)+1});
      savePlanning({queued:true});
    }
    if (healthSharing.localPlanText||healthSharing.localGoalTitle) saveHealthSharing({...healthSharing,
      ...(validatedLayout?{localPlanText:false,tasks:[]}: {})});
    if (validatedLayout) replaceHealthReminders(item.requestId||newId('adopt'),goalKey);
    if (pendingTask?.requestId) saveTicket(null);
    savePlanning({...planningState,evaluated:null,goalIntent:null,nextReviewAt:null});
    void reviewHealthContext('feedback');
  }
  function dismiss() { recordPlanningFeedback('保留原任务');saveTicket(null);render(); }
  async function answer(value) {
    if (pendingTask?.assessment?.decision==='need_data'&&!planningBusy) {
      recordPlanningFeedback(value,pendingTask.error);
      if (pendingTask.originalRequest) saveTicket(null);
      await reviewHealthContext('feedback');
    }
  }
  function accept() {
    if (!pendingTask?.suggestion) return;
    let grantsNarrowed=false;
    if (pendingTask.layout) {
      const original=pendingTask.originalRequest||planningState.request;
      if (!original||original.requestId!==pendingTask.requestId||!planningResultIsCurrent(original)) {
        saveTicket(null);void reviewHealthContext('review');render();return;
      }
      const changesById=new Map((pendingTask.assessment?.changes||[]).map(change=>[change.taskId,change.operation]));
      const elapsed=pendingTask.layout.tasks.some(task=>task.kind==='reminder'&&
        ['add','update'].includes(changesById.get(task.id))&&!(Date.parse(task.scheduledFor)>Date.now()));
      if (elapsed) {
        saveTicket(null);
        void reviewHealthContext('feedback');
        notice('提醒时间已过，Along 正在按现在的时间重新评估');
        return;
      }
      goalLayouts[goalKey]=validateAdaptiveLayout(pendingTask.layout,goalDomain(goalKey));
      const changes=pendingTask.assessment?.changes||[];
      const reviewOnly=Object.keys(healthSharing.reviewAccess||{}).length>0;
      if (healthSharing.tasks?.length||reviewOnly) {
        const tasks=(healthSharing.tasks||[]).filter(t=>goalLayouts[goalKey].tasks.some(task=>task.id===t.id));
        for (const change of changes) {
          if (change.operation!=='add'&&change.operation!=='update') continue;
          const index=tasks.findIndex(t=>t.id===change.taskId);
          if (index>=0) tasks[index]={...tasks[index],localText:reviewOnly};
          else if (reviewOnly) tasks.push({id:change.taskId,alias:newId('private-task'),localText:true});
        }
        saveHealthSharing({...healthSharing,tasks});
        if (reviewOnly) {
          // Each grant covers the contents the user previewed. Edits and new
          // tasks can quote protected material, including after adoption.
          const grants=Object.fromEntries(accessOptions().filter(o=>o.checked).map(o=>[o.key,o.value]));
          grantsNarrowed=Object.keys(grants).length<Object.keys(healthSharing.reviewAccess||{}).length;
          if (grantsNarrowed) {
            saveHealthSharing({...healthSharing,reviewAccess:grants,scope:(healthSharing.scope||0)+1});
            const {evaluated,localDate,nextReviewAt}=planningState;
            savePlanning({lastDecision:latestDecision(),evaluated,localDate,nextReviewAt,goalIntent:healthGoalIntent()});
          }
        }
      }
      saveGoalLayouts();
      replaceHealthReminders(pendingTask.requestId,goalKey);
    }
    goalCustom[goalKey]={...goalCustom[goalKey],task:pendingTask.suggestion.task,reason:pendingTask.suggestion.reason};
    recordPlanningFeedback('采用了调整',grantsNarrowed?'用户已确认更新任务。':pendingTask.reason);
    saveGoalCustom();saveTicket(null);render();notice('下一步已更新');
  }
  return {get state(){return planningState;},get sharing(){return healthSharing;},get ticket(){return pendingTask;},
    localHealthPlan,shareableHealthTask,accessOptions,workoutTarget,latestDecision,setAccess,dailyDelegation,todayActions,claimDailyDelegation,revokeDaily,canRecoverConnection,backgroundTemplate,retireNative,claimBackground,reviewHealthContext,refreshHealthReview,accept,dismiss,answer,instruct,clear,restrict,goalUpdated};
}
window.addEventListener('along-health-update', async event => {
  if (document.visibilityState==='hidden'||state.loop?.experiment === EXPERIMENT) return;
  const previous=state.source==='healthkit'?state.snapshot:null;
  let next;
  try { next=setSnapshot(state,event.detail,'healthkit'); }
  catch { return; }
  nativeHealthStatus='available';
  nativeObservationSeen=true;
  saveHealth(next);
  await reviewAll('observation',previous);
  if (screen==='home') render();
});
window.addEventListener('along-notification-open', event => {
  const detail=event.detail;
  if (!detail || typeof detail!=='object') return;
  const goalKey=detail.goalKey;
  if (goalKey!=='health' && goalKey!=='finance' && !isCustomGoalKey(goalKey)) return;
  activeGoal=goalKey;
  localStorage.setItem(ACTIVE_GOAL_KEY,activeGoal);
  if (hasHealthSource(goalKey)&&['sleep','workout'].includes(detail.dailyTopic)) {
    screen='home';
    readNextGoalReminder(goalKey,true);readDailyAgenda(goalKey,true);render();
    requestAnimationFrame(()=>app.querySelector('[data-daily-topic="'+detail.dailyTopic+'"]')?.scrollIntoView?.({block:'center'}));
    return;
  }
  if (hasHealthSource(goalKey)&&detail.requestId&&detail.requestId===reviewFor(goalKey).ticket?.requestId) {
    screen='home';
  } else if (detail.kind==='task' && typeof detail.taskId==='string'&&currentTaskRecords().some(t=>t.id===detail.taskId)) {
    selectedTaskId=detail.taskId;
    screen='task';
  } else if (detail.reminderTitle&&detail.kind==='task') {
    screen='home';
    readNextGoalReminder(goalKey,true);
    notice(String(detail.reminderTitle));
  } else screen='agent';
  render();
});
sheet.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') sheet.close();
  if (action === 'open-duolingo') window.location.href='https://www.duolingo.com/learn';
  if (action === 'health-demo') {
    saveHealth(setSnapshot(state, {steps:6842, weightKg:64.2, workoutMinutes:75, workoutCount:2, sleepMinutes:437}, 'demo'));
    sheet.close();
  }
});
const recoveredInitialCustomGoal=adoptPendingInitialCustomGoal();
if ('scrollRestoration' in history) history.scrollRestoration='manual';
render();
requestAnimationFrame(()=>window.scrollTo({top:0,left:0,behavior:'instant'}));
setTimeout(()=>window.scrollTo({top:0,left:0,behavior:'instant'}),120);
setTimeout(()=>window.scrollTo({top:0,left:0,behavior:'instant'}),420);
if (recoveredInitialCustomGoal) notice('已恢复新目标和动态任务');
async function restoreAlongConnection() {
  try {
    const saved=await loadNativeConnection();
    if (saved?.baseURL&&saved?.fingerprint&&saved?.token) {
      agentConfig=saved;
      persistAgentConfig(saved);
      render();
    } else if (agentConfig.token) {
      await saveNativeConnection(agentConfig);
    }
  } catch {
    // A transient Keychain failure leaves the WKWebView connection available.
  }
  nativeConnectionRestored=true;queueBackgroundSync();
  if (agentConfig.token) {
    void refreshAgentConnection();
    if (nativeObservationSeen) void reviewAll();
  }
}
void restoreAlongConnection();
let lastNativeRefresh = 0;
let readingNative=false;
async function refreshFromNative(force=false) {
  if (!window.AlongHealthBridge?.refresh||readingNative||document.visibilityState==='hidden') return;
  if (!force&&Date.now()-lastNativeRefresh<15_000) return;
  readingNative=true;
  lastNativeRefresh=Date.now();
  const generation=sourceGeneration;
  try {
    const snapshot=await window.AlongHealthBridge.refresh();
    if (generation===sourceGeneration) window.dispatchEvent(new CustomEvent('along-health-update',{detail:snapshot}));
  } catch(error) {
    if (generation!==sourceGeneration) return;
    if (error?.code==='health_not_connected') {
      if (nativeHealthStatus!=='unlinked') {
        // Only the native bridge can say that the local selection was removed.
        // Forget stale requests before a late host result can restore a proposal.
        for (const key of healthGoalKeys()) reviewFor(key).clear();
      }
      nativeHealthStatus='unlinked';
    } else nativeHealthStatus='unavailable';
    if (screen==='home') render();
  } finally { readingNative=false; }
}
void refreshFromNative();
function resumeNativeHealth() {
  if (window.AlongHealthBridge?.backgroundReview&&window.AlongHealthBridge.refresh) {
    nativeObservationSeen=false;
    nativeHealthStatus='checking';
    backgroundReplace=null;
    void refreshFromNative(true);
  } else void refreshFromNative();
}
window.addEventListener('pageshow', () => {resumeNativeHealth();for (const key of healthGoalKeys()) void syncHealthReminders(key);});
window.addEventListener('focus', () => void refreshFromNative());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resumeNativeHealth(); });
setInterval(async () => {
  if (document.visibilityState!=='visible') return;
  await refreshFromNative();
  if (screen==='home') {readNextGoalReminder(activeGoal);readDailyAgenda(activeGoal);}
  if (!readingNative) void reviewAll('review');
  if (!verifiedHealthHost&&agentConfig.token&&nativeHealthStatus==='available'&&healthGoalKeys().some(key=>reviewFor(key).canRecoverConnection()))
    void refreshAgentConnection({healthOnly:true});
},60_000);
setInterval(() => {
  if (screen!=='task' || document.visibilityState==='hidden') return;
  const task=selectedTask();
  if (!task) return;
  void refreshSuperAgentTask(task);
},4_000);
setInterval(() => {
  if (document.visibilityState==='hidden') return;
  for (const key of healthGoalKeys()) void reviewFor(key).refreshHealthReview();
  if (screen==='agent') void refreshSuperAgentGoal(activeGoal);
},3_000);
