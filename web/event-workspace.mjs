import {agentCall, queueEvent, flushEventQueue, pendingEvents, readEventFailures,bindEventAuthority,retireEventAuthority} from './agent-client.mjs?v=102';
import {assembleEnvelope} from './event-envelope.mjs?v=102';
import {validateGoalReply} from './goal-agent-core.mjs?v=102';
import {safeAdaptiveLayout} from './adaptive-ui.mjs?v=102';
import {safeRecommendation} from './recommendations.mjs?v=102';
import {safeDataSources} from './data-sources.mjs?v=102';
import {taskResultRelevant,resultEvidence,validResultEvidence} from './task-results.mjs?v=102';
import {safeResultPresentation,RESULT_TEXT_LIMIT,wellFormedResultText} from './task-result-view.mjs?v=102';

const id = value => typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const record = value => value!==null && typeof value==='object' && !Array.isArray(value);
const text = (value,max) => typeof value==='string' && value.trim().length>0 && value.length<=max;
const version = value => Number.isSafeInteger(value) && value>=0;
const time = value => typeof value==='string' && Number.isFinite(Date.parse(value));

// 相邻两条消息间隔达到 30 分钟，或落到设备本地时区的另一个日历日，就断一段。
export const CHAT_TIME_GAP = 30*60*1000;

// 时间只用于显示：缺失、空串、非字符串或非法日期（如 2 月 30 日）都按「这条没有时间」处理。
function chatTimeValue(value) {
  if (!absoluteTime(value)) return null;
  const at=Date.parse(value);
  return Number.isFinite(at)?at:null;
}
// 设备本地时区的日历日。跨日判断和「当天」的文案都用它，不用 UTC。
function chatDayKey(value) {
  const date=new Date(value);
  return `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`;
}
function chatTimeLabel(value, now) {
  const date=new Date(value);
  const clock=`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
  if (chatDayKey(value)===chatDayKey(now)) return clock;
  return `${date.getFullYear()}年${String(date.getMonth()+1).padStart(2,'0')}月${String(date.getDate()).padStart(2,'0')}日 ${clock}`;
}

/**
 * 按可见消息的顺序，算出每条消息前要不要显示时间分割线。
 * 只跟上一条「有时间的消息」比较：缺时间或时间无效的消息保留气泡，但不参与门槛，
 * 下一条有时间的消息仍跟更早那条有效消息比。两个条件同时成立也只显示一次。
 */
export function chatTimeline(messages, now = Date.now()) {
  const dividers=new Array(messages.length).fill(null);
  let previous=null;
  messages.forEach((message,index)=>{
    const at=chatTimeValue(message?.sentAt);
    if (at===null) return;
    if (previous===null||at-previous>=CHAT_TIME_GAP||chatDayKey(at)!==chatDayKey(previous)) {
      dividers[index]={at,label:chatTimeLabel(at,now)};
    }
    previous=at;
  });
  return dividers;
}

/**
 * 阅读锚点：记下读者正在看的那条气泡在视口里的位置。
 * 只按 scrollTop 复位不够——历史回放补时间会在阅读位置上方插入分割线，
 * 同样的 scrollTop 会让整段内容下移，读者正在读的那条气泡被推走。
 *
 * 选哪一条：
 * - 完全在视口外的气泡不能当锚点（读者根本没在看它）。
 * - 优先取第一条**完整可见**的气泡：只露出一条边的已经在被读过去。
 * - 没有完整可见的气泡时，取**露出最多**的那条：一条长回复盖住整屏时，
 *   或者视口两端各露一点时，露出的那条才是读者正在读的；下沿只露 6px 的
 *   那条不是。
 * 锚点用消息自己的 eventId 认人，不用下标：消息列表可能增删，下标会指错人。
 */
export function captureChatAnchor(scroller) {
  if (!scroller||typeof scroller.getBoundingClientRect!=='function') return null;
  const box=scroller.getBoundingClientRect();
  if (!box) return null;
  let largest=null;
  for (const bubble of scroller.querySelectorAll?.('.agent-message')||[]) {
    const id=bubble.dataset?.eventId;
    if (!id) continue;
    const rect=bubble.getBoundingClientRect?.();
    if (!rect) continue;
    const visible=Math.min(rect.bottom,box.bottom)-Math.max(rect.top,box.top);
    if (visible<=0) continue;
    if (rect.top>=box.top&&rect.bottom<=box.bottom) return {id,offset:rect.top-box.top};
    if (!largest||visible>largest.visible) largest={id,offset:rect.top-box.top,visible};
  }
  return largest?{id:largest.id,offset:largest.offset}:null;
}

/** 按锚点复位：让同一条气泡回到同一个视口位置，锚点找不到就交回调用方按原逻辑处理。 */
export function anchoredScrollTop(scroller,anchor) {
  if (!scroller||!anchor?.id) return null;
  const bubble=[...(scroller.querySelectorAll?.('.agent-message')||[])].find(item=>item.dataset?.eventId===anchor.id);
  if (!bubble) return null;
  const rect=bubble.getBoundingClientRect?.(),box=scroller.getBoundingClientRect?.();
  if (!rect||!box) return null;
  // 气泡在新内容里的位置，减去锚点原本的视口位置，得到需要补偿的滚动量。
  const top=(rect.top-box.top+(scroller.scrollTop||0))-anchor.offset;
  const max=Math.max(0,(scroller.scrollHeight||0)-(scroller.clientHeight||0));
  return Math.min(Math.max(0,top),max);
}
const empty = userId => ({version:1,recommendationsVersion:1,conversationVersion:1,dataSourcesVersion:1,executionVersion:2,taskCapabilityVersion:1,resultPresentationVersion:1,userId,cursor:0,goals:{},messages:{},drafts:{},activeGoalId:null,conversationId:null,returnGoalId:null});

// 带时区的绝对时间。日历上不存在的日期（2 月 30 日）会被 Date.parse 进位成下个月，这里挡掉。
function absoluteTime(value) {
  if (!time(value)||!/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return false;
  const day=value.slice(0,10),utc=Date.parse(day+'T00:00:00Z');
  return Number.isFinite(utc)&&new Date(utc).toISOString().slice(0,10)===day;
}
function matchesReminderClock(scheduledAt,wallTime,timezone) {
  const day=86400_000;
  const civil=instant=>{
    const fields=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hourCycle:'h23',
      year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})
      .formatToParts(new Date(instant)).map(part=>[part.type,part.value]));
    return Date.UTC(+fields.year,+fields.month-1,+fields.day,+fields.hour,+fields.minute,+fields.second);
  };
  const scheduled=Date.parse(scheduledAt),local=civil(scheduled),clock=civil(Date.parse(wallTime))%day;
  if (local%day===clock) return true;
  // A shifted clock is valid only for the exact civil-time gap on this occurrence's date.
  const target=Math.floor(local/day)*day+clock;
  const offsets=[-day,day].map(delta=>civil(target+delta)-(target+delta));
  const next=[...new Set(offsets)].map(offset=>target-offset).filter(at=>civil(at)>=target)
    .sort((a,b)=>civil(a)-civil(b)||a-b)[0];
  return next===Math.floor(scheduled/1000)*1000;
}
function cleanTaskReminder(task) {
  const {reminderPlan:plan,scheduledAt}=task;
  if (plan===undefined) {
    if (scheduledAt!==undefined&&!time(scheduledAt)) throw Error('任务同步格式不正确');
    return {scheduledAt};
  }
  if (!record(plan)) return {};
  if (plan.state==='scheduled'&&absoluteTime(scheduledAt)&&['user','agent'].includes(plan.source)&&
      ['once','daily','weekly'].includes(plan.repeat)) {
    const explanation=typeof plan.explanation==='string'?plan.explanation.trim():'';
    const weekly=plan.repeat==='weekly';
    if (explanation.length<2||explanation.length>240||
        (weekly?!(Number.isInteger(plan.weekday)&&plan.weekday>=1&&plan.weekday<=7):plan.weekday!==undefined)) return {};
    if (plan.timezone!==undefined) {
      if (!text(plan.timezone,100)||!/^\w+(?:\/[\w+.-]+)*$/.test(plan.timezone)) return {};
      try {
        const day=new Intl.DateTimeFormat('en-US',{timeZone:plan.timezone,weekday:'short'}).format(new Date(scheduledAt));
        if (weekly&&['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(day)+1!==plan.weekday) return {};
      } catch { return {}; }
    }
    if (plan.wallTime!==undefined&&(!absoluteTime(plan.wallTime)||!plan.timezone||
        !matchesReminderClock(scheduledAt,plan.wallTime,plan.timezone))) return {};
    return {scheduledAt,reminderPlan:{state:'scheduled',source:plan.source,explanation,repeat:plan.repeat,
      ...(weekly?{weekday:plan.weekday}:{}),...(plan.timezone===undefined?{}:{timezone:plan.timezone}),
      ...(plan.wallTime===undefined?{}:{wallTime:plan.wallTime})}};
  }
  if (scheduledAt!==undefined) return {};
  if (plan.state==='off'&&['opt_out','untimed'].includes(plan.reason)) return {reminderPlan:{state:'off',reason:plan.reason}};
  if (plan.state==='needs_time'&&typeof plan.question==='string') {
    const question=plan.question.trim();
    if (question.length>=2&&question.length<=240) return {reminderPlan:{state:'needs_time',question}};
  }
  return {};
}

export const recurringPlan = task => task.reminderPlan?.state==='scheduled'&&task.reminderPlan.timezone&&['daily','weekly'].includes(task.reminderPlan.repeat);

function isActiveGoal(value, goalId) {
  return goalId != null && value.goals[goalId]?.status === 'active';
}

function conversationGoal(value, conversationId = value.conversationId) {
  if (!conversationId) return null;
  return Object.values(value.messages).find(message =>
    message.conversationId === conversationId && message.goalId)?.goalId ?? null;
}

// Optional host-computed history cannot make a valid old goal unreadable.
function cleanTaskExecution(value) {
  if (!record(value)||value.version!==1||!Number.isSafeInteger(value.count)||value.count<0||
      !Array.isArray(value.records)||value.records.length>20||value.count<value.records.length) return {};
  const seen=new Set(),records=[];
  for (const item of value.records) {
    if (!record(item)||typeof item.id!=='string'||!item.id||item.id.length>300||seen.has(item.id)||
        !['research','calculation','completed'].includes(item.kind)||!time(item.executedAt)||
        item.outcome!==({research:'researched',calculation:'calculated',completed:'completed'}[item.kind])||
        (item.summary!==undefined&&!text(item.summary,item.kind==='calculation'?240:120))||
        (item.recommendationEventId!==undefined&&!eventId(item.recommendationEventId))||
        (item.calculationReceiptId!==undefined&&!(typeof item.calculationReceiptId==='string'&&/^calc_[a-f0-9]{40}$/.test(item.calculationReceiptId)))) return {};
    seen.add(item.id);records.push({id:item.id,kind:item.kind,executedAt:item.executedAt,outcome:item.outcome,
      ...(item.calculationReceiptId?{calculationReceiptId:item.calculationReceiptId}:{}),...(item.summary?{summary:item.summary}:{}),...(item.recommendationEventId?{recommendationEventId:item.recommendationEventId}:{})});
  }
  return {execution:{version:1,count:value.count,records}};
}

// Optional trusted trigger metadata is display context, never permission to execute on the client.
function cleanTaskTrigger(t) {
  if(!record(t)||t.version!==1||!['immediate','time','event','waiting'].includes(t.kind)||
    !['user','agent'].includes(t.actor)||!['reminder','research','calculation'].includes(t.capability)||
    t.actor==='user'&&t.capability!=='reminder'||!['pending','scheduled','waiting','running','settled','cancelled'].includes(t.state)||
    !text(t.label,240)||typeof t.notifyBefore!=='boolean'||!Array.isArray(t.conditions)||t.conditions.length>4)return {};
  const conditions=[];
  for(const c of t.conditions) {
    if(!record(c))return {};
    if(['source_ready','source_updated'].includes(c.kind)&&c.provider==='okx'&&c.capability==='trading_account_summary')conditions.push({kind:c.kind,provider:c.provider,capability:c.capability});
    else if(c.kind==='task_completed'&&id(c.task_id))conditions.push({kind:c.kind,task_id:c.task_id});
    else if(c.kind==='health_available'&&['steps','workout','active_energy','weight','resting_heart_rate','wrist_temperature','sleep'].includes(c.type))conditions.push({kind:c.kind,type:c.type});
    else return {};
  }
  return {trigger:{version:1,kind:t.kind,actor:t.actor,capability:t.capability,state:t.state,label:t.label,conditions,notifyBefore:t.notifyBefore}};
}

// 完成事实台账（本地）：已提交但服务端快照尚未确认的任务。损坏的条目直接丢弃，不让整份缓存作废。
// outcome 是这条完成事实自己的终态回执：queued=已入队还没有终态回执，accepted=服务端已受理，
// failed=服务端终态拒收。台账按任务记账，不受别的任务的失败记录影响。
function completionsOf(value) {
  if (!record(value)) return {};
  const out={};
  for (const [taskId,entry] of Object.entries(value)) {
    if (!id(taskId)||!record(entry)||!eventId(entry.eventId)||!id(entry.goalId)||!version(entry.revision)) continue;
    if (entry.outcome!==undefined&&!['queued','accepted','failed'].includes(entry.outcome)) continue;
    out[taskId]={eventId:entry.eventId,goalId:entry.goalId,revision:entry.revision,
      ...(entry.outcome===undefined?{}:{outcome:entry.outcome})};
  }
  return out;
}
// 历史任务分页缓存：目标快照之外、按需取回的那些任务（当前目标一份，切换目标即从头再来）。
function historyOf(value) {
  if (!record(value)||!id(value.goalId)||!Array.isArray(value.tasks)) return undefined;
  const tasks=[];
  for (const task of value.tasks) {
    if (!record(task)||!id(task.id)||!text(task.content,120)||!version(task.revision)) continue;
    tasks.push(task);
  }
  return {goalId:value.goalId,tasks,cursor:typeof value.cursor==='string'&&value.cursor.length>0?value.cursor:undefined,exhausted:value.exhausted===true};
}

// One task of a goal, cleaned by the same rules the goal snapshot uses.
function cleanGoalTask(task,goalId,seen) {
  if (!record(task)||!id(task.id)||(seen!==undefined&&seen.has(task.id))||task.goalId!==goalId||!text(task.content,120)||!version(task.currentRevision)||
      !['open','done','cancelled'].includes(task.status)) throw Error('任务同步格式不正确');
  seen?.add(task.id);
  return {id:task.id,goalId:goalId,content:task.content,status:task.status,revision:task.currentRevision,
    ...cleanTaskReminder(task),...cleanTaskExecution(task.execution),...cleanTaskTrigger(task.trigger)};
}
// One page of a goal's tasks (history): same task rules, same goal identity as the snapshot.
function safeTaskPage(items,goal) {
  if (!Array.isArray(items)||items.length>200) throw Error('历史任务同步格式不正确');
  const seen=new Set();
  return items.map(item=>cleanGoalTask(item,goal.id,seen));
}

// Wire snapshots are validated before entering the cache; layouts are deterministic projections, not model HTML.
export function safeWorkspaceGoal(snapshot) {
  if (!record(snapshot)||!record(snapshot.goal)||!record(snapshot.revision)||!Array.isArray(snapshot.tasks)) throw Error('目标同步格式不正确');
  const {goal,revision,tasks}=snapshot;
  if (!id(goal.id)||!['health','finance','custom'].includes(goal.domain)||!['active','archived'].includes(goal.status)||
      !version(goal.currentRevision)||goal.currentRevision<1||revision.revision!==goal.currentRevision||revision.goalId!==goal.id||
      !text(revision.title,80)||revision.status!==goal.status) throw Error('目标同步版本不正确');
  const metric=revision.metric;
  if (goal.domain==='custom' ? metric!=null : !record(metric)||!text(metric.type,64)||!text(metric.unit,16)||!text(metric.period,32)) throw Error('目标指标格式不正确');
  if (revision.context!=null && (!Array.isArray(revision.context)||revision.context.length>20||revision.context.some(item=>
    typeof item==='string'?!text(item,300):!record(item)||!text(item.text,300)||(item.until!==undefined&&!time(item.until))))) throw Error('目标情境格式不正确');
  const seen=new Set();
  const cleanTasks=tasks.map(task=>cleanGoalTask(task,goal.id,seen));
  validateGoalReply({reply:'目标已同步',proposal:{title:revision.title,target:metric?.target??null,
    task:cleanTasks[0]?.content||'通过聊天安排下一步',reason:'已校验的目标状态'}},goal.domain,'');
  const layout=safeAdaptiveLayout({version:1,title:revision.title,summary:'按你的目标持续调整',
    modules:[],tasks:cleanTasks.filter(task=>task.status==='open').slice(0,6).map(task=>({id:task.id,when:task.scheduledAt||'下一步',
      title:'下一步',detail:task.content,state:'planned'})),questions:[],connections:[]},goal.domain);
  if (!layout) throw Error('目标页面校验失败');
  return {id:goal.id,domain:goal.domain,status:goal.status,revision:goal.currentRevision,title:revision.title,
    metric:metric??null,context:revision.context??[],tasks:cleanTasks,layout,dataSources:safeDataSources(snapshot.dataSources)};
}

function safeMessage(message,item) {
  if (!record(message)||!text(message.id,300)||!(id(message.eventId)||item.payload.presentation==='execution'&&eventId(message.eventId))||!['user','assistant','system'].includes(message.role)||
      !['inbound','outbound'].includes(message.direction)||!version(message.seq)||message.seq<1||
      (message.causationId!==undefined&&!id(message.causationId))||
      (message.userId!==undefined&&message.userId!==item.userId)||
      (item.payload.conversation_id!==undefined&&!id(item.payload.conversation_id))||
      (message.audience!==undefined&&!['conversation','background'].includes(message.audience))||
      (item.payload.audience!==undefined&&(!['conversation','background'].includes(item.payload.audience)||message.audience!==undefined&&message.audience!==item.payload.audience))) throw Error('对话同步格式不正确');
  const clean={id:message.id,eventId:message.eventId,role:message.role,text:message.text,seq:message.seq,
    goalId:item.goalId,conversationId:item.payload.conversation_id??message.causationId??(item.payload.presentation==='execution'?undefined:message.eventId),
    replyToMessageId:message.replyToMessageId,presentation:item.payload.presentation,
    audience:message.audience??item.payload.audience??(item.payload.presentation==='execution'?'background':'conversation'),
    ...(item.goalId&&id(item.taskId)?{taskId:item.taskId}:{}),
    ...(message.role==='assistant'&&item.goalId&&safeRecommendation(item.payload.recommendation)?{recommendation:safeRecommendation(item.payload.recommendation)}:{}),
    notificationEventId:eventId(item.payload.notification?.event_id)&&['recommendation_ready','task_result'].includes(item.payload.notification.kind)
      ?item.payload.notification.event_id:undefined,
    ...(version(item.payload.notification?.revision)?{notificationRevision:item.payload.notification.revision}:{}),
    ...(version(item.payload.task_execution_revision)&&item.payload.task_execution_revision>0?{taskExecutionRevision:item.payload.task_execution_revision}:{}),
    ...(resultEvidence(item.payload)?{resultEvidence:resultEvidence(item.payload)}:{}),status:'received'};
  // 发送时间只是显示用的可选字段：用户消息用入队信封的 occurred_at，Agent 回复用落库时间。
  // 缺失或非法就当这条没有时间，不影响气泡本身。
  const sentAt=message.role==='user'?message.occurredAt:message.createdAt;
  if (absoluteTime(sentAt)) clean.sentAt=sentAt;
  const goal=item.goalId?safeWorkspaceGoal(item.payload.snapshot):undefined,task=goal?.tasks.find(task=>task.id===clean.taskId);
  const scopedResult=storedResultBody(clean,goal,task);
  if(!text(message.text,scopedResult?RESULT_TEXT_LIMIT:2000))throw Error('对话同步格式不正确');
  // New servers keep message.text short for pre-upgrade clients. The separate complete body
  // never grants result authority, and cannot enter ordinary chat or another task's cache.
  if(scopedResult&&item.payload.result_text!==undefined) {
    if(!text(item.payload.result_text,RESULT_TEXT_LIMIT)||!wellFormedResultText(item.payload.result_text))throw Error('执行结果正文格式不正确');
    clean.text=item.payload.result_text;
  }
  const presentation=scopedResult?safeResultPresentation(item.payload.result_presentation):null;
  if(presentation)clean.resultPresentation=presentation;
  return clean;
}

// A replay attaches the current task snapshot, whose recent 20 receipts may no longer contain this
// historical result. Preserve host-bound occurrence metadata; current display/notification relevance
// remains stricter and is evaluated separately by taskResultBodyRelevant/taskResultRelevant.
function storedResultBody(message,goal,task) {
  const e=message.resultEvidence;
  const bound=message.role==='assistant'&&message.status==='received'&&message.audience==='background'&&
    goal&&goal.id===message.goalId&&task&&task.goalId===goal.id&&task.id===message.taskId&&
    eventId(message.notificationEventId)&&message.notificationEventId===message.eventId&&
    Number.isSafeInteger(message.notificationRevision)&&message.notificationRevision>0&&message.notificationRevision<=task.revision&&
    Number.isSafeInteger(message.taskExecutionRevision)&&message.taskExecutionRevision>0&&message.taskExecutionRevision<=message.notificationRevision&&
    validResultEvidence(e);
  if(!bound)return false;
  if(message.notificationRevision<task.revision)return true;
  return !!task.execution?.records.some(item=>e.kind==='calculation'
      ?item.kind==='calculation'&&item.outcome==='calculated'&&item.calculationReceiptId===e.id
      :item.kind==='research'&&item.outcome==='researched'&&item.recommendationEventId===e.id);
}
function cachedResultBody(message,goals) {
  const goal=goals[message.goalId],task=goal?.tasks.find(task=>task.id===message.taskId);
  return storedResultBody(message,goal,task);
}

const freshResult = value => {
  const age=Date.now()-Date.parse(value);
  return age>=-60_000 && age<=600_000;
};
const eventId = value => typeof value==='string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);

function validResult(r) {
  return record(r)&&eventId(r.eventId)&&id(r.goalId)&&(r.taskId==null||id(r.taskId))&&version(r.revision)&&
    ['recommendation_ready','task_result'].includes(r.kind)&&time(r.createdAt)&&(r.evidence===undefined||validResultEvidence(r.evidence));
}

function applicableResult(r,goals) {
  if (!freshResult(r.createdAt)) return false;
  const goal=goals[r.goalId];
  if (goal?.status!=='active') return false;
  return taskResultRelevant(r,goal,goal.tasks.find(t=>t.id===r.taskId));
}

function localResult(item,remote) {
  const n=item.payload.notification;
  if (item.payload.classification_only===true||remote!==false||!record(n)||!id(item.goalId)||!eventId(n.event_id)||
      !['recommendation_ready','task_result'].includes(n.kind)||!version(n.revision)||
      !freshResult(item.createdAt)||(item.taskId!=null&&!id(item.taskId))) return null;
  return {eventId:n.event_id,kind:n.kind,goalId:item.goalId,taskId:item.taskId??undefined,revision:n.revision,createdAt:item.createdAt,...(resultEvidence(item.payload)?{evidence:resultEvidence(item.payload)}:{})};
}

// 一套范围规则，页面渲染与等待判定共用（docs/bugfix-goal-prompt.md §7：同一件事的两条读取路径要给同样的结论）。
// 会话归属只认消息自己的 conversationId；目标只决定「这条消息算不算当前可见的目标」——
// 消息自己的 goalId 最直接：服务端在 goal.create 回链时会把会话里的消息改挂到新目标，
// 沿用旧的目标关联会把刚回链的原话判到旧目标上。消息没有 goalId 时才回退到它所属会话的目标关联。
// 不用 message.goalId===activeGoalId 直接筛：本机刚提交、服务端还没回填 goalId 的原话会被误判成不在范围内，
// 于是会话刚被绑定到目标，等待行就提前消失。
function visibleScope(state) {
  const goalsByConversation=new Map();
  for (const message of Object.values(state.messages)) {
    if (message.goalId&&message.conversationId&&!goalsByConversation.has(message.conversationId)) {
      goalsByConversation.set(message.conversationId,message.goalId);
    }
  }
  const activeGoalId=state.activeGoalId??null;
  const conversationId=state.conversationId??null;
  const goalOf=message=>message.goalId??goalsByConversation.get(message.conversationId)??null;
  const inScope=message=>activeGoalId===null
    ?message.conversationId===conversationId
    :goalOf(message)===activeGoalId;
  const visible=message=>message.audience!=='background'&&message.presentation!=='execution';
  return {activeGoalId,conversationId,goalOf,inScope,visible};
}

// 等待态从持久缓存派生，不放在页面的瞬时变量里：同步和重渲染后仍然成立，重启后也能接着显示。
// 入参已经是范围内且可见的消息（见 visibleScope）。只有最新的一条原话还等着答复——
// 更新的原话会取代它（服务端把旧工作判为 conflicted_input），而答复总是落在同一会话里、排在原话之后。
// 本机刚提交、还没有服务端 seq 的原话视为最新。
function awaitingReply(messages,pending,error) {
  let request;
  for (const message of messages) {
    if (message.role!=='user') continue;
    if (!request) {request=message;continue;}
    const prior=version(request.seq)?request.seq:null,seq=version(message.seq)?message.seq:null;
    // 本机待回显的原话比任何已存记录都新；两条都还没 seq 时按缓存插入顺序取后一条。
    if (prior===null) {if (seq===null) request=message;continue;}
    if (seq===null||seq>=prior) request=message;
  }
  if (!request||request.status==='failed'||request.status==='rejected') return null;
  // 队列里还在、同步也已报错，是明确的离线待同步，不再声称 Agent 正在回复。
  if (pending.has(request.eventId)&&error) return null;
  // 没有 seq 说明刚在本机提交，任何已存答复都早于它。
  if (!version(request.seq)) return request;
  const answered=messages.some(message=>message.role==='assistant'&&
    message.conversationId===request.conversationId&&version(message.seq)&&message.seq>request.seq);
  return answered?null:request;
}

export function createEventWorkspace({config,onChange=()=>{},onNotifications}) {
  if (!id(config?.userId)) throw Error('缺少服务端绑定用户');
  bindEventAuthority(config);
  const key=`along.event-workspace.v1:${config.userId}`;
  let state=empty(config.userId),flight=null,lastError='',disposed=false;
  // 历史翻页的批次序号与会话号：已落地的批次号用来识别迟到的旧批次响应，
  // 会话号在切换目标时立即作废，用来识别换目标前发出的旧请求。
  let historySeq=0,appliedHistorySeq=0,historySession=0;
  try {
    const saved=JSON.parse(localStorage.getItem(key));
    if (saved?.version===1&&saved.userId===config.userId&&version(saved.cursor)&&record(saved.goals)&&record(saved.messages)) {
      for (const [key,goal] of Object.entries(saved.goals)) {
        if (!record(goal)||key!==goal.id) throw Error('bad cache');
        saved.goals[key]=safeWorkspaceGoal({goal:{...goal,currentRevision:goal.revision},
          revision:{goalId:goal.id,revision:goal.revision,title:goal.title,status:goal.status,metric:goal.metric,context:goal.context},
          tasks:goal.tasks.map(task=>({...task,currentRevision:task.revision})),dataSources:goal.dataSources});
      }
      let migratedReceipt=false;
      for (const [key,message] of Object.entries(saved.messages)) {
        if (!record(message)||message.eventId!==key||!text(message.text,cachedResultBody(message,saved.goals)?RESULT_TEXT_LIMIT:2000)||
          !['user','assistant','system'].includes(message.role)||(message.goalId!==undefined&&!id(message.goalId))) throw Error('bad cache');
        if (message.audience!==undefined&&!['conversation','background'].includes(message.audience)) throw Error('bad cache');
        if (message.recommendation!==undefined) {
          const r=message.role==='assistant'&&message.goalId&&safeRecommendation(message.recommendation);
          if (r) message.recommendation=r; else delete message.recommendation;
        }
        if(message.resultPresentation!==undefined) {
          const presentation=cachedResultBody(message,saved.goals)&&safeResultPresentation(message.resultPresentation);
          if(presentation)message.resultPresentation=presentation;else delete message.resultPresentation;
        }
        if(message.resultEvidence!==undefined&&!validResultEvidence(message.resultEvidence))delete message.resultEvidence;
        if(message.notificationRevision!==undefined&&!version(message.notificationRevision))delete message.notificationRevision;
        if (message.taskId!==undefined&&(!id(message.taskId)||!saved.goals[message.goalId]?.tasks.some(t=>t.id===message.taskId))) delete message.taskId;
        if (message.conversationId!==undefined&&!id(message.conversationId)) {
          // Older versions used the receipt's own event ID when the sender supplied no conversation.
          if (message.presentation!=='execution'||message.role!=='assistant'||message.status!=='received'||
            !id(message.goalId)||!Object.hasOwn(saved.goals,message.goalId)||message.conversationId!==key||!eventId(key)) throw Error('bad cache');
          delete message.conversationId;
          migratedReceipt=true;
        }
      }
      if (saved.drafts!==undefined&&(!record(saved.drafts)||Object.entries(saved.drafts).some(([scope,value])=>
          !/^(?:goal|conversation):[A-Za-z0-9_-]{1,96}$/.test(scope)||typeof value!=='string'||value.length>800))||
          saved.activeGoalId!==null&&!id(saved.activeGoalId)||saved.conversationId!==null&&!id(saved.conversationId)||
          saved.returnGoalId!==undefined&&saved.returnGoalId!==null&&!id(saved.returnGoalId)||
          saved.pendingAck!==undefined&&(!Array.isArray(saved.pendingAck)||saved.pendingAck.some(seq=>!version(seq)||seq<1||seq>saved.cursor))) throw Error('bad cache');
      saved.notificationResults=Array.isArray(saved.notificationResults)?saved.notificationResults.filter(validResult):[];
      saved.notificationReceipts=Array.isArray(saved.notificationReceipts)?saved.notificationReceipts.filter(eventId):[];
      saved.drafts=saved.drafts??{};
      saved.returnGoalId=saved.returnGoalId??null;
      // 完成事实台账与历史任务分页缓存：坏条目丢弃，不让整份缓存作废。
      saved.completions=completionsOf(saved.completions);
      saved.history=historyOf(saved.history);
      if (saved.recommendationsVersion!==1&&(!version(saved.recommendationReplayAfter)||saved.recommendationReplayAfter>saved.cursor)) saved.recommendationReplayAfter=0;
      if (saved.conversationVersion!==1&&(!version(saved.conversationReplayAfter)||saved.conversationReplayAfter>saved.cursor)) saved.conversationReplayAfter=0;
      if (saved.taskCapabilityVersion!==1&&(!version(saved.taskCapabilityReplayAfter)||saved.taskCapabilityReplayAfter>saved.cursor)) saved.taskCapabilityReplayAfter=0;
      if (saved.resultPresentationVersion!==1&&(!version(saved.resultPresentationReplayAfter)||saved.resultPresentationReplayAfter>saved.cursor)) saved.resultPresentationReplayAfter=0;
      if (saved.executionVersion!==2) {
        if(saved.executionReplayVersion!==2||!version(saved.executionReplayAfter)||saved.executionReplayAfter>saved.cursor)saved.executionReplayAfter=0;
        saved.executionReplayVersion=2;
      }
      if (saved.dataSourcesVersion!==1&&(!version(saved.dataSourcesReplayAfter)||saved.dataSourcesReplayAfter>saved.cursor)) saved.dataSourcesReplayAfter=0;
      state=saved;
      if (migratedReceipt) {
        try { localStorage.setItem(key,JSON.stringify(saved)); } catch { /* Keep the validated goals available offline. */ }
      }
    }
  } catch { /* A damaged cache is rebuilt from the durable server outbox. */ }
  // Old v1 caches did not record an explicit composer selection. Preserve actual unbound messages/drafts.
  function restoreSelection(next) {
    const selected=next.goals[next.activeGoalId];
    if (!isActiveGoal(next,next.returnGoalId)) next.returnGoalId=null;
    if (selected?.status==='active') return;
    // A removed selection may keep a truly unbound conversation, never a root of an old goal.
    if (next.activeGoalId!=null && conversationGoal(next)!==null) next.conversationId=null;
    if (next.composing===undefined) {
      const conversation=next.conversationId;
      next.composing=!selected && (Boolean(next.drafts?.[`conversation:${conversation??'new'}`]) ||
        Boolean(conversation && Object.values(next.messages).some(m=>m.conversationId===conversation&&!m.goalId) &&
          !Object.values(next.messages).some(m=>m.conversationId===conversation&&m.goalId)));
    }
    if (next.composing) {next.activeGoalId=null;return;}
    const last=next.goals[next.returnGoalId];
    const candidate=last?.status==='active'?last:Object.values(next.goals).find(g=>g.status==='active');
    next.activeGoalId=candidate?.id??null;
    next.returnGoalId=candidate?.id??null;
  }
  restoreSelection(state);
  function save(next) {
    if (disposed) throw Error('连接已切换');
    restoreSelection(next);
    localStorage.setItem(key,JSON.stringify(next));
    state=next;
  }
  function recoverPending() {
    const next=structuredClone(state);
    for (const {envelope} of pendingEvents(config)) {
      if (envelope.event_type!=='along.user_message') continue;
      // 待发的原话按入队时间参与时间分割线；队列里还在，就可以按同一 eventId 补回这个时间。
      const sentAt=absoluteTime(envelope.occurred_at)?envelope.occurred_at:undefined;
      const cached=next.messages[envelope.event_id];
      if (!cached) next.messages[envelope.event_id]={eventId:envelope.event_id,role:'user',text:envelope.payload.text,
        goalId:envelope.goal_id,conversationId:envelope.causation_id??envelope.event_id,status:'pending',...(sentAt?{sentAt}:{})};
      else if (sentAt&&!cached.sentAt) next.messages[envelope.event_id]={...cached,sentAt};
    }
    return next;
  }
  function view() {
    const next=recoverPending(),failures=readEventFailures(config),pending=new Set(pendingEvents(config).map(item=>item.event_id));
    const messages=Object.values(next.messages).map(message=>({...message,
      status:failures.some(item=>item.event_id===message.eventId)?'rejected':pending.has(message.eventId)?'pending':message.status}));
    // 范围只有一份，页面渲染与等待判定共用（visibleScope）。
    const scope=visibleScope(next);
    const scopedMessages=messages.filter(scope.inScope);
    const visibleMessages=scopedMessages.filter(scope.visible);
    return {...next,draftScope:draftScope(next),error:lastError,messages,scopedMessages,visibleMessages,
      awaiting:awaitingReply(visibleMessages,pending,lastError)};
  }
  function draftScope(value=state) {
    const conversationScope = `conversation:${value.conversationId??'new'}`;
    if (!value.activeGoalId) return conversationScope;
    // A follow-up typed before binding still belongs to that conversation. Resolve it through
    // persisted messages even after navigating away; keep an older goal draft separate.
    const drafts = value.drafts??{};
    const boundScope = [conversationScope, ...Object.keys(drafts).reverse()].find(scope =>
      scope.startsWith('conversation:') && drafts[scope] &&
      conversationGoal(value, scope.slice('conversation:'.length)) === value.activeGoalId);
    return boundScope??`goal:${value.activeGoalId}`;
  }
  function draft() { return state.drafts?.[draftScope()]??''; }
  function setDraft(value) {
    const clean=typeof value==='string'?value.slice(0,800):'';
    const drafts={...state.drafts};
    if (clean) drafts[draftScope()]=clean;
    else delete drafts[draftScope()];
    save({...state,drafts,composing:state.activeGoalId?state.composing:true});
  }
  function select(goalId) {
    if (goalId!==null&&!isActiveGoal(state,goalId)) return;
    // 换了目标：旧的分页会话立即作废，在途的旧响应回来时不得再写入任何状态。
    if (goalId!==state.activeGoalId) historySession+=1;
    const returnGoalId=goalId===null
      ? (state.goals[state.activeGoalId]?.status==='active'?state.activeGoalId:state.returnGoalId)
      : goalId;
    // Reopening "new goal" resumes an unbound conversation. This preserves both its durable
    // messages and any follow-up draft written after the first send. Once the server binds that
    // conversation to a goal, the next "new goal" starts from a clean conversation instead.
    const conversationId=goalId===null&&conversationGoal(state)?null:state.conversationId;
    save({...state,activeGoalId:goalId,conversationId,returnGoalId,composing:goalId===null});onChange();
  }
  function leaveConversation() {
    const returnGoalId=state.goals[state.returnGoalId]?.status==='active'?state.returnGoalId:null;
    // Keep conversationId and its durable outbox intact. A late Agent result must stay bound to
    // this conversation, while the goal the user returned to remains the visible selection.
    const next={...state,activeGoalId:returnGoalId,returnGoalId,composing:false};
    restoreSelection(next);save(next);onChange();
    return next.activeGoalId;
  }
  /**
   * 尚未了结的完成反馈：同一个任务不重复提交（服务端按事件号幂等，重复提交也不会累加执行次数）。
   *
   * 终态回执（被拒／冲突）已经了结——那条事实不会再送达，任务回到可完成状态，用户可以重试。
   * 依据是**这条完成事实自己的回执**（台账里的 outcome），不是本地失败台账：失败台账有 50 条上限，
   * 别的任务失败得多了会把这条挤掉，那时「没在失败台账里」不再等于「被受理过」。
   */
  function pendingTaskCompletions() {
    const ids=new Set();
    for (const {envelope} of pendingEvents(config)) {
      if (envelope?.kind==='task.completed'&&typeof envelope.task_id==='string') ids.add(envelope.task_id);
    }
    for (const [taskId,entry] of Object.entries(completionsOf(state.completions))) {
      if (entry.outcome==='failed') continue;
      ids.add(taskId);
    }
    return ids;
  }
  /**
   * 服务端已受理的完成事实：台账里这条完成事实的终态回执是 accepted。
   *
   * 服务端受理了完成事实，这条任务就不再是「待完成」——即便这一版服务端不为完成事实
   * 补发带目标快照的同步项（那样客户端永远等不到新快照，任务会一直挂在当前列表里）。
   * 服务端补发了快照时，这条任务在快照里已经是 done，两者口径一致。
   *
   * 判据是**受理这件事本身**（回执），不是「没被拒收」：被拒收的事实只要回执还在，就永远不会被
   * 当成已受理。没有 outcome 的旧台账条目（更早的客户端写的）沿用旧口径推断。
   */
  function acceptedTaskCompletions() {
    const queued=new Set(pendingEvents(config).map(item=>item.event_id));
    const failed=new Set(readEventFailures(config).map(item=>item.event_id));
    const ids=new Set();
    for (const [taskId,entry] of Object.entries(completionsOf(state.completions))) {
      if (entry.outcome==='accepted') {ids.add(taskId);continue;}
      // 旧台账没有回执：沿用旧口径（不在队列里、也没有失败记录）推断已受理。
      if (entry.outcome!==undefined) continue;
      if (queued.has(entry.eventId)||failed.has(entry.eventId)) continue;
      ids.add(taskId);
    }
    return ids;
  }
  /**
   * 提交一次完成事实：组装既有 `task.completed` 信封并入队（发送由随后的 sync 完成）。
   * 状态只来自服务端快照——这里不改任何任务状态，任务是否完成由服务端回执后的同步结果决定。
   */
  async function completeTask(taskId) {
    const goalId=state.activeGoalId, goal=goalId?state.goals[goalId]:undefined;
    const task=goal?.tasks.find(item=>item.id===taskId);
    if (!goal||!task||task.status!=='open') throw Error('该任务当前不可完成');
    if (pendingTaskCompletions().has(taskId)) throw Error('完成反馈已提交');
    const completedAt=new Date().toISOString();
    const assembled=assembleEnvelope({event_type:'along.message',kind:'task.completed',occurred_at:completedAt,
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Shanghai',
      goal_id:goal.id,task_id:task.id,
      payload:{event_type:'along.message',kind:'task.completed',task_id:task.id,completed_at:completedAt}});
    if (!assembled.ok) throw Error(assembled.reason);
    const receipt=await queueEvent(config,assembled.envelope,{send:false});
    if (!receipt.ok) throw Error(receipt.reason);
    // 普通任务：提交后等服务端快照确认（完成或版本前进）。同步故障期间不重复提交，
    // 同一任务只产生一次 done 版本与一条同步项。周期任务由服务端按周期去重，下一次仍可完成。
    const completions={...completionsOf(state.completions)};
    if (!recurringPlan(task)) completions[taskId]={eventId:receipt.event_id,goalId,revision:task.revision,outcome:'queued'};
    try { save({...state,completions}); } catch { state={...state,completions}; }
    onChange();
    return receipt.event_id;
  }
  /**
   * 把投递的终态回执记到各自的完成事实上：accepted/duplicate=服务端已受理，rejected/conflict=终态拒收。
   * 依据是这条事实自己的回执，与同步成败无关，也与别的任务的失败记录无关。
   */
  function recordDeliveryOutcomes(outcomes) {
    if (!Array.isArray(outcomes)||outcomes.length===0) return;
    const completions={...completionsOf(state.completions)};
    let changed=false;
    for (const outcome of outcomes) {
      const status=outcome?.status;
      if (status!=='accepted'&&status!=='duplicate'&&status!=='rejected'&&status!=='conflict') continue;
      const resolved=status==='accepted'||status==='duplicate'?'accepted':'failed';
      for (const [taskId,entry] of Object.entries(completions)) {
        if (entry.eventId!==outcome.event_id||entry.outcome===resolved) continue;
        completions[taskId]={...entry,outcome:resolved};
        changed=true;
      }
    }
    if (!changed) return;
    const next={...state,completions};
    try { save(next); } catch { state=next; }
    onChange();
  }
  /**
   * 历史任务按需翻页：目标快照只带最近 200 条任务，更早的按页取回，不放大每次同步的快照。
   * 返回本次新增的任务数与是否已到尽头。
   */
  async function loadHistoryPage() {
    const goalId=state.activeGoalId, goal=goalId?state.goals[goalId]:undefined;
    if (!goalId||!goal) throw Error('没有选中目标');
    const history=historyOf(state.history);
    const current=history&&history.goalId===goalId?history:{tasks:[],cursor:undefined,exhausted:false};
    if (current.exhausted) return {added:0,exhausted:true};
    // 记住发起请求时的那一批（游标）、序号与会话：响应只能写回同一目标、同一批次、同一会话。
    const batch=current.cursor, seq=++historySeq, session=historySession;
    const page=await agentCall(config,'/sync',{after_seq:state.cursor,limit:1,conversation_version:1,
      tasks_page:{goal_id:goalId,status:'done',limit:50,...(current.cursor?{cursor:current.cursor}:{})}});
    // 迟到的响应（换了目标导致会话作废、期间换了目标、同目标已翻到别的批次，或已有更新的批次落地）直接丢弃：
    // 它不得改写当前目标的卡片、游标与「加载更早的任务」收口状态。
    if (session!==historySession) return {added:0,exhausted:true};
    if (state.activeGoalId!==goalId) return {added:0,exhausted:true};
    if (seq<=appliedHistorySeq) return {added:0,exhausted:true};
    const latest=historyOf(state.history);
    const entry=latest&&latest.goalId===goalId?latest:undefined;
    if ((entry?.cursor??undefined)!==batch) return {added:0,exhausted:true};
    appliedHistorySeq=seq;
    const tasksPage=record(page)?page.tasks_page:undefined;
    if (!record(tasksPage)||!Array.isArray(tasksPage.items)) throw Error('历史任务同步格式不正确');
    // 与目标快照同一套任务校验（同一目标、同一字段口径），标题与指标不重复信任远端。
    const pageTasks=safeTaskPage(tasksPage.items,goal);
    const cursor=typeof tasksPage.nextCursor==='string'&&tasksPage.nextCursor.length>0?tasksPage.nextCursor:undefined;
    // 已经看得见的（快照里的已完成任务 + 已翻过的页）不算新增：翻页要一直翻到出现新的历史任务为止。
    const visible=new Set([...goal.tasks.filter(task=>task.status==='done').map(task=>task.id),
      ...current.tasks.map(task=>task.id)]);
    const fresh=pageTasks.filter(task=>!visible.has(task.id));
    const known=new Set(current.tasks.map(task=>task.id));
    const tasks=[...current.tasks,...fresh.filter(task=>!known.has(task.id))];
    const next={...state,history:{goalId,tasks,cursor,exhausted:cursor===undefined}};
    try { save(next); } catch { state=next; }
    onChange();
    return {added:fresh.length,exhausted:cursor===undefined};
  }
  /** 历史任务列表：目标快照里的已完成任务，加上按需翻页取回的那部分（按 id 去重）。 */
  function historyTasks() {
    const goal=state.activeGoalId?state.goals[state.activeGoalId]:undefined;
    if (!goal) return [];
    const base=goal.tasks.filter(task=>task.status==='done');
    const history=historyOf(state.history);
    if (!history||history.goalId!==goal.id) return base;
    const seen=new Set(base.map(task=>task.id));
    return [...base,...history.tasks.filter(task=>!seen.has(task.id))];
  }
  /** 历史任务是否已翻到尽头（没翻过时保守当作还有更早的，翻页确认后才收口）。 */
  function historyExhausted() {
    const goal=state.activeGoalId?state.goals[state.activeGoalId]:undefined;
    if (!goal) return true;
    const history=historyOf(state.history);
    if (!history||history.goalId!==goal.id) return false;
    return history.exhausted;
  }
  /**
   * 某个目标的某个任务：先看目标快照，再看按需翻页取回的那部分。
   * 分页加载出来的历史卡片因此也能打开自己的详情。
   */
  function taskById(goalId,taskId) {
    const goal=goalId?state.goals[goalId]:undefined;
    if (!goal||!id(taskId)) return undefined;
    const found=goal.tasks.find(task=>task.id===taskId);
    if (found) return found;
    const history=historyOf(state.history);
    if (!history||history.goalId!==goal.id) return undefined;
    return history.tasks.find(task=>task.id===taskId);
  }
  /**
   * 台账收敛：服务端快照确认完成（或版本前进）后移除记录；终态拒收的记录同样移除——那条事实
   * 不会再送达，留着也只是历史，用户重新提交时会写新的记录。周期任务不记台账——服务端按周期
   * 去重，下一次仍可完成。
   */
  function pruneCompletions(next) {
    const completions=completionsOf(next.completions);
    const kept={};
    for (const [taskId,entry] of Object.entries(completions)) {
      if (entry.outcome==='failed') continue;
      const goal=next.goals[entry.goalId];
      const task=goal?.tasks.find(item=>item.id===taskId);
      if (task&&(task.status==='done'||task.revision>entry.revision)) continue;
      kept[taskId]=entry;
    }
    next.completions=kept;
    return next;
  }
  function prepareRecommendationFeedback(eventId) {
    const message=state.messages[eventId];
    if (!message?.recommendation||message.goalId!==state.activeGoalId||!isActiveGoal(state,state.activeGoalId)) return false;
    const taskId=message.taskId&&state.goals[state.activeGoalId].tasks.find(t=>t.id===message.taskId&&t.status!=='cancelled')?.id;
    const scope=draftScope(state),draft=state.drafts?.[scope]||`关于「${message.recommendation.title}」，`;
    save({...state,drafts:{...state.drafts,[scope]:draft},feedbackContext:{goalId:state.activeGoalId,...(taskId?{taskId}:{})}});
    onChange();return true;
  }
  async function submit(message) {
    if (!text(message,800)) throw Error('请输入 800 字以内的消息');
    const next=recoverPending();
    const composingScope=draftScope(next);
    if (!next.activeGoalId) next.composing=true;
    const assembled=assembleEnvelope({event_type:'along.user_message',occurred_at:new Date().toISOString(),
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Shanghai',goal_id:next.activeGoalId??undefined,
      causation_id:next.activeGoalId===null?next.conversationId??undefined:undefined,
      task_id:next.feedbackContext?.goalId===next.activeGoalId&&next.goals[next.activeGoalId]?.tasks.some(t=>t.id===next.feedbackContext.taskId&&t.status!=='cancelled')?next.feedbackContext.taskId:undefined,
      payload:{event_type:'along.user_message',text:message}});
    if (!assembled.ok) throw Error(assembled.reason);
    const receipt=await queueEvent(config,assembled.envelope,{send:false});
    if (!receipt.ok) throw Error(receipt.reason);
    // 会话根跟着目标走，和服务端一致：客户端只给未绑定目标的会话带 causation_id，
    // 服务端因此把每条目标内消息各自起一段会话（服务端 inbox 的 conversationRoot 就是这么定的）。
    // 复用上一个目标的会话根会让这条原话挂到旧目标上——切换目标后当前目标看不到自己的原话和
    // 等待行，旧目标反而显示别人的原话（独立复核第 1 条回归）。
    const root=next.activeGoalId===null?(next.conversationId??receipt.event_id):receipt.event_id;
    next.conversationId=root;
    next.drafts={...next.drafts};delete next.drafts[composingScope];delete next.feedbackContext;
    next.messages[receipt.event_id]={eventId:receipt.event_id,role:'user',text:message,goalId:next.activeGoalId??undefined,conversationId:root,status:'pending',
      ...(absoluteTime(assembled.envelope.occurred_at)?{sentAt:assembled.envelope.occurred_at}:{})};
    // The queue is already durable even if this display cache cannot be written.
    try { save(next); } catch { state=next; }
    onChange();
    return receipt.event_id;
  }
  async function synchronize() {
    if (state.pendingAck?.length) {
      await agentCall(config,'/sync/ack',{seqs:state.pendingAck});
      save({...state,pendingAck:[]});
    }
    const pendingBefore=JSON.stringify([pendingEvents(config),readEventFailures(config)]);
    const flushed=await flushEventQueue(config);
    if(disposed) return;
    // 投递的终态回执先记到各自的完成事实上：受理了就不再是「待完成」，终态拒收就回到可重试。
    // 这一步与同步成败无关，也不依赖本地失败台账（那份台账有上限，会被别的任务挤掉）。
    recordDeliveryOutcomes(flushed?.outcomes);
    if (JSON.stringify([pendingEvents(config),readEventFailures(config)])!==pendingBefore) onChange();
    for (;;) {
      const receipts=onNotifications?(state.notificationReceipts??[]).slice(0,50):[];
      // Old clients acknowledged messages without retaining the optional recommendation.
      // Replay once from the durable outbox, preserving the acknowledged cursor and drafts.
      const replayConversation=state.conversationVersion!==1;
      const replaySources=state.dataSourcesVersion!==1;
      const replayResults=state.resultPresentationVersion!==1;
      const replay=state.recommendationsVersion!==1||replayConversation||replaySources||state.executionVersion!==2||state.taskCapabilityVersion!==1||replayResults;
      // An older migration may already be part-way through. A newly added projection
      // still needs its earlier pages, so all pending migrations share the earliest cursor.
      const replayCursors=[...(state.recommendationsVersion!==1?[state.recommendationReplayAfter??0]:[]),
        ...(replayConversation?[state.conversationReplayAfter??0]:[]),...(replaySources?[state.dataSourcesReplayAfter??0]:[]),...(state.executionVersion!==2?[state.executionReplayAfter??0]:[]),...(state.taskCapabilityVersion!==1?[state.taskCapabilityReplayAfter??0]:[]),...(replayResults?[state.resultPresentationReplayAfter??0]:[])];
      const after=replay?Math.min(...replayCursors):state.cursor;
      const page=await agentCall(config,'/sync',{after_seq:after,limit:50,conversation_version:1,
        ...(onNotifications?{notificationFallback:true,notificationReceipts:receipts}:{})});
      if(disposed) return;
      if (!record(page)||!Array.isArray(page.items)||page.items.length>50) throw Error('同步响应格式不正确');
      const next=recoverPending(),seqs=[];
      const fallbacks=onNotifications?page.notificationFallback??[]:[];
      if (!Array.isArray(fallbacks)||fallbacks.length>50||fallbacks.some(r=>!validResult(r)||r.userId!==config.userId)) throw Error('通知补投格式不正确');
      if (fallbacks.length) {
        const pending=new Map((next.notificationResults??[]).map(r=>[r.eventId,r]));
        for (const r of fallbacks) pending.set(r.eventId,{eventId:r.eventId,kind:r.kind,goalId:r.goalId,taskId:r.taskId??undefined,
          revision:r.revision,createdAt:r.createdAt,...(r.evidence?{evidence:r.evidence}:{}),fallback:true});
        next.notificationResults=[...pending.values()];
      }
      if (receipts.length) next.notificationReceipts=next.notificationReceipts.filter(id=>!receipts.includes(id));
      if (page.items.length===0) {
        if (page.nextCursor!==undefined) throw Error('同步分页游标不正确');
        if (replay) {next.recommendationsVersion=1;next.conversationVersion=1;next.dataSourcesVersion=1;next.executionVersion=2;next.taskCapabilityVersion=1;next.resultPresentationVersion=1;delete next.resultPresentationReplayAfter;delete next.taskCapabilityReplayAfter;delete next.recommendationReplayAfter;delete next.conversationReplayAfter;delete next.dataSourcesReplayAfter;delete next.executionReplayAfter;delete next.executionReplayVersion;}
        if (replay||fallbacks.length||receipts.length) save(next);
        // 终态回执（被拒／冲突）立刻收敛完成事实台账：任务回到可完成状态，不必等下一张有内容的同步页。
        const beforeCompletions=JSON.stringify(completionsOf(next.completions));
        pruneCompletions(next);
        const completionsChanged=JSON.stringify(next.completions)!==beforeCompletions;
        if (completionsChanged) {save(next);onChange();}
        break;
      }
      let previous=after;
      for (const item of page.items) {
        if (!record(item)||!version(item.seq)||item.seq<=previous||item.userId!==config.userId||!record(item.payload)||
            !['goal_updated','task_updated','changeset_note','message','delivery_failed'].includes(item.kind)||
            (item.goalId!==undefined&&!id(item.goalId))) throw Error('同步记录格式不正确');
        previous=item.seq;seqs.push(item.seq);
        if (item.goalId!==undefined) {
          const goal=safeWorkspaceGoal(item.payload.snapshot);
          if (goal.id!==item.goalId) throw Error('目标同步关联不正确');
          if (!next.goals[goal.id]||goal.revision>=next.goals[goal.id].revision) next.goals[goal.id]=goal;
        }
        if (onNotifications&&(!replay||item.seq>state.cursor)&&item.seq>(state.notificationHandoffThrough??0)) {
          const notice=localResult(item,item.remoteNotifications??page.remoteNotifications);
          if (notice) {
            const queue=next.notificationResults??[];
            if (!queue.some(r=>r.eventId===notice.eventId)) next.notificationResults=[...queue,notice];
          }
        }
        if (item.kind==='message') {
          const message=safeMessage(item.payload.message,item);
          next.messages[message.eventId]=message;
          if (item.goalId&&state.activeGoalId===null&&message.conversationId===state.conversationId) {
            next.activeGoalId=item.goalId;next.returnGoalId=item.goalId;next.composing=false;
          }
        }
        if (item.kind==='delivery_failed') {
          const eventId=item.payload.event_id;
          if (id(eventId)&&next.messages[eventId]) next.messages[eventId]={...next.messages[eventId],status:'failed'};
        }
      }
      if (page.nextCursor!==undefined&&String(page.nextCursor)!==String(previous)) throw Error('同步分页游标不正确');
      restoreSelection(next);
      // 快照确认后收敛完成事实台账：同一任务不再重复提交完成事实。
      pruneCompletions(next);
      next.cursor=Math.max(next.cursor,previous);next.pendingAck=seqs;
      if (replay) {
        if (page.nextCursor===undefined) {next.recommendationsVersion=1;next.conversationVersion=1;next.dataSourcesVersion=1;next.executionVersion=2;next.taskCapabilityVersion=1;next.resultPresentationVersion=1;delete next.resultPresentationReplayAfter;delete next.taskCapabilityReplayAfter;delete next.recommendationReplayAfter;delete next.conversationReplayAfter;delete next.dataSourcesReplayAfter;delete next.executionReplayAfter;delete next.executionReplayVersion;}
        else {next.recommendationReplayAfter=previous;if(replayConversation)next.conversationReplayAfter=previous;if(replaySources)next.dataSourcesReplayAfter=previous;if(state.executionVersion!==2)next.executionReplayAfter=previous;if(state.taskCapabilityVersion!==1)next.taskCapabilityReplayAfter=previous;if(replayResults)next.resultPresentationReplayAfter=previous;}
      }
      save(next);onChange();
      // Cache commit precedes ack. A failed ack is retried before pulling further, without replaying data.
      await agentCall(config,'/sync/ack',{seqs});
      save({...state,pendingAck:[]});
      if (page.nextCursor===undefined) break;
    }
    if (onNotifications&&!disposed) {
      // Reconcile only a complete sync. A torn page, stale connection or offline cache must never withdraw other tasks.
      const active=Object.values(state.goals).filter(g=>g.status==='active');
      const reminders=active.flatMap(g=>g.tasks.filter(t=>t.status==='open'&&(!t.trigger||t.trigger.actor==='user'||t.trigger.notifyBefore===true)&&
        (Date.parse(t.scheduledAt)>Date.now()||recurringPlan(t)))
        .map(t=>({goalId:g.id,taskId:t.id,revision:t.revision,scheduledAt:new Date(t.scheduledAt).toISOString(),body:t.content,
          ...(recurringPlan(t)?{repeat:t.reminderPlan.repeat,timezone:t.reminderPlan.timezone,
            ...(t.reminderPlan.wallTime?{wallTime:t.reminderPlan.wallTime}:{}),
            ...(t.reminderPlan.repeat==='weekly'?{weekday:t.reminderPlan.weekday}:{})}:{})})));
      const activeTasks=active.flatMap(g=>g.tasks.filter(t=>t.status==='open').map(t=>({goalId:g.id,taskId:t.id,revision:t.revision})));
      const queued=state.notificationResults??[];
      const results=queued.filter(r=>applicableResult(r,state.goals));
      // 归属标识用 bindingScopeId，不再用叶指纹：换叶证书不会被当成新用户
      // （docs/iphone-ca-profile-design.md §2.2）。
      await onNotifications({userId:config.userId,bindingScopeId:config.bindingScopeId,cursor:state.cursor,reminders,activeTasks,results});
      if (!disposed&&queued.length) {
        const receipts=new Set(state.notificationReceipts??[]);
        for (const r of queued) if (r.fallback) receipts.add(r.eventId);
        save({...state,notificationResults:[],notificationReceipts:[...receipts]});
      }
    }
  }
  function sync() {
    if(disposed) return Promise.resolve();
    if (flight) return flight;
    const beforeError=lastError;
    flight=synchronize().then(()=>{lastError='';}).catch(error=>{lastError=error?.message||'同步未完成';})
      .finally(()=>{flight=null;if(!disposed&&lastError!==beforeError) onChange();});
    return flight;
  }
  return {view,draft,setDraft,select,leaveConversation,prepareRecommendationFeedback,completeTask,pendingTaskCompletions,acceptedTaskCompletions,loadHistoryPage,historyTasks,historyExhausted,taskById,submit,sync,dispose:()=>{disposed=true;retireEventAuthority(config);}};
}
