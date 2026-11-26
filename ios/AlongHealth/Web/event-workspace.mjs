import {agentCall, queueEvent, flushEventQueue, pendingEvents, readEventFailures,bindEventAuthority,retireEventAuthority} from './agent-client.mjs';
import {assembleEnvelope} from './event-envelope.mjs';
import {validateGoalReply} from './goal-agent-core.mjs';
import {safeAdaptiveLayout} from './adaptive-ui.mjs';
import {safeRecommendation} from './recommendations.mjs';
import {safeDataSources} from './data-sources.mjs';
import {taskResultRelevant,resultEvidence,validResultEvidence} from './task-results.mjs';
import {safeResultPresentation,RESULT_TEXT_LIMIT,wellFormedResultText} from './task-result-view.mjs';

const id = value => typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const record = value => value!==null && typeof value==='object' && !Array.isArray(value);
const text = (value,max) => typeof value==='string' && value.trim().length>0 && value.length<=max;
const version = value => Number.isSafeInteger(value) && value>=0;
const time = value => typeof value==='string' && Number.isFinite(Date.parse(value));
const empty = userId => ({version:1,recommendationsVersion:1,conversationVersion:1,dataSourcesVersion:1,executionVersion:2,taskCapabilityVersion:1,resultPresentationVersion:1,userId,cursor:0,goals:{},messages:{},drafts:{},activeGoalId:null,conversationId:null,returnGoalId:null});

function absoluteReminderTime(value) {
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
  if (plan.state==='scheduled'&&absoluteReminderTime(scheduledAt)&&['user','agent'].includes(plan.source)&&
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
    if (plan.wallTime!==undefined&&(!absoluteReminderTime(plan.wallTime)||!plan.timezone||
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

const recurringPlan = task => task.reminderPlan?.state==='scheduled'&&task.reminderPlan.timezone&&['daily','weekly'].includes(task.reminderPlan.repeat);

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
  const cleanTasks=tasks.map(task=>{
    if (!record(task)||!id(task.id)||seen.has(task.id)||task.goalId!==goal.id||!text(task.content,120)||!version(task.currentRevision)||
        !['open','done','cancelled'].includes(task.status)) throw Error('任务同步格式不正确');
    seen.add(task.id);
    return {id:task.id,goalId:goal.id,content:task.content,status:task.status,revision:task.currentRevision,...cleanTaskReminder(task),...cleanTaskExecution(task.execution),...cleanTaskTrigger(task.trigger)};
  });
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

// 等待态从持久缓存派生，不放在页面的瞬时变量里：同步和重渲染后仍然成立，重启后也能接着显示。
// 只有可见范围内最新的一条原话还等着答复——更新的原话会取代它（服务端把旧工作判为 conflicted_input），
// 而答复总是落在同一会话里、排在原话之后。本机刚提交、还没有服务端 seq 的原话视为最新。
function awaitingReply(messages,pending,error,inScope) {
  const visible=message=>message.audience!=='background'&&message.presentation!=='execution';
  let request;
  for (const message of messages) {
    if (message.role!=='user'||!visible(message)||!inScope(message)) continue;
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
  const answered=messages.some(message=>message.role==='assistant'&&visible(message)&&
    message.conversationId===request.conversationId&&version(message.seq)&&message.seq>request.seq);
  return answered?null:request;
}

export function createEventWorkspace({config,onChange=()=>{},onNotifications}) {
  if (!id(config?.userId)) throw Error('缺少服务端绑定用户');
  bindEventAuthority(config);
  const key=`along.event-workspace.v1:${config.userId}`;
  let state=empty(config.userId),flight=null,lastError='',disposed=false;
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
      if (!next.messages[envelope.event_id]) next.messages[envelope.event_id]={eventId:envelope.event_id,role:'user',text:envelope.payload.text,
        goalId:envelope.goal_id,conversationId:envelope.causation_id??envelope.event_id,status:'pending'};
    }
    return next;
  }
  function view() {
    const next=recoverPending(),failures=readEventFailures(config),pending=new Set(pendingEvents(config).map(item=>item.event_id));
    const messages=Object.values(next.messages).map(message=>({...message,
      status:failures.some(item=>item.event_id===message.eventId)?'rejected':pending.has(message.eventId)?'pending':message.status}));
    // 与页面可见历史同一范围：已选目标按目标，未绑定目标时按当前会话。
    const inScope=message=>next.activeGoalId==null?message.conversationId===next.conversationId:message.goalId===next.activeGoalId;
    return {...next,draftScope:draftScope(next),error:lastError,messages,
      awaiting:awaitingReply(messages,pending,lastError,inScope)};
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
  // 已入队但尚未送达的完成反馈：同一个任务不重复提交（服务端按事件号幂等，重复提交也不会累加执行次数）。
  function pendingTaskCompletions() {
    const ids=new Set();
    for (const {envelope} of pendingEvents(config)) {
      if (envelope?.kind==='task.completed'&&typeof envelope.task_id==='string') ids.add(envelope.task_id);
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
    onChange();
    return receipt.event_id;
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
    const root=next.conversationId??receipt.event_id;
    next.conversationId=root;
    next.drafts={...next.drafts};delete next.drafts[composingScope];delete next.feedbackContext;
    next.messages[receipt.event_id]={eventId:receipt.event_id,role:'user',text:message,goalId:next.activeGoalId??undefined,conversationId:root,status:'pending'};
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
    await flushEventQueue(config);
    if(disposed) return;
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
  return {view,draft,setDraft,select,leaveConversation,prepareRecommendationFeedback,completeTask,pendingTaskCompletions,submit,sync,dispose:()=>{disposed=true;retireEventAuthority(config);}};
}
