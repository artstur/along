import {agentCall, queueEvent, flushEventQueue, pendingEvents, readEventFailures} from './agent-client.mjs';
import {assembleEnvelope} from './event-envelope.mjs';
import {validateGoalReply} from './goal-agent-core.mjs';
import {safeAdaptiveLayout} from './adaptive-ui.mjs';

const id = value => typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const record = value => value!==null && typeof value==='object' && !Array.isArray(value);
const text = (value,max) => typeof value==='string' && value.trim().length>0 && value.length<=max;
const version = value => Number.isSafeInteger(value) && value>=0;
const time = value => typeof value==='string' && Number.isFinite(Date.parse(value));
const empty = userId => ({version:1,userId,cursor:0,goals:{},messages:{},drafts:{},activeGoalId:null,conversationId:null,returnGoalId:null});

function isActiveGoal(value, goalId) {
  return goalId != null && value.goals[goalId]?.status === 'active';
}

function conversationGoal(value) {
  if (!value.conversationId) return null;
  return Object.values(value.messages).find(message =>
    message.conversationId === value.conversationId && message.goalId)?.goalId ?? null;
}

// Apply the same navigation invariant to restored caches and every state transition. Keep
// history and drafts intact. Once a selection disappears, only an unbound new conversation
// may remain selected; a root bound to any existing goal must not receive a fresh goal message.
function reconcileSelection(value) {
  const activeGoalId = isActiveGoal(value, value.activeGoalId) ? value.activeGoalId : null;
  const lostSelection = value.activeGoalId != null && activeGoalId === null;
  const detachConversation = lostSelection && conversationGoal(value) !== null;
  return {...value, activeGoalId,
    returnGoalId: isActiveGoal(value, value.returnGoalId) ? value.returnGoalId : null,
    conversationId: detachConversation ? null : value.conversationId};
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
        !['open','done','cancelled'].includes(task.status)||(task.scheduledAt!==undefined&&!time(task.scheduledAt))) throw Error('任务同步格式不正确');
    seen.add(task.id);
    return {id:task.id,goalId:goal.id,content:task.content,status:task.status,revision:task.currentRevision,scheduledAt:task.scheduledAt};
  });
  validateGoalReply({reply:'目标已同步',proposal:{title:revision.title,target:metric?.target??null,
    task:cleanTasks[0]?.content||'通过聊天安排下一步',reason:'已校验的目标状态'}},goal.domain,'');
  const layout=safeAdaptiveLayout({version:1,title:revision.title,summary:goal.domain==='finance'?'理财使用演示数据':'按你的目标持续调整',
    modules:[],tasks:cleanTasks.filter(task=>task.status==='open').slice(0,6).map(task=>({id:task.id,when:task.scheduledAt||'下一步',
      title:'下一步',detail:task.content,state:'planned'})),questions:[],connections:[]},goal.domain);
  if (!layout) throw Error('目标页面校验失败');
  return {id:goal.id,domain:goal.domain,status:goal.status,revision:goal.currentRevision,title:revision.title,
    metric:metric??null,context:revision.context??[],tasks:cleanTasks,layout};
}

function safeMessage(message,item) {
  if (!record(message)||!text(message.id,300)||!(id(message.eventId)||item.payload.presentation==='execution'&&text(message.eventId,200))||!['user','assistant','system'].includes(message.role)||
      !['inbound','outbound'].includes(message.direction)||!text(message.text,2000)||!version(message.seq)||message.seq<1||
      (message.causationId!==undefined&&!id(message.causationId))||
      (message.userId!==undefined&&message.userId!==item.userId)||
      (item.payload.conversation_id!==undefined&&!id(item.payload.conversation_id))) throw Error('对话同步格式不正确');
  return {id:message.id,eventId:message.eventId,role:message.role,text:message.text,seq:message.seq,
    goalId:item.goalId,conversationId:item.payload.conversation_id??message.causationId??message.eventId,
    replyToMessageId:message.replyToMessageId,presentation:item.payload.presentation,
    notificationEventId:eventId(item.payload.notification?.event_id)&&['recommendation_ready','task_result'].includes(item.payload.notification.kind)
      ?item.payload.notification.event_id:undefined,status:'received'};
}

const freshResult = value => {
  const age=Date.now()-Date.parse(value);
  return age>=-60_000 && age<=600_000;
};
const eventId = value => typeof value==='string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);

function validResult(r) {
  return record(r)&&eventId(r.eventId)&&id(r.goalId)&&(r.taskId==null||id(r.taskId))&&version(r.revision)&&
    ['recommendation_ready','task_result'].includes(r.kind)&&time(r.createdAt);
}

function applicableResult(r,goals) {
  if (!freshResult(r.createdAt)) return false;
  const goal=goals[r.goalId];
  if (goal?.status!=='active') return false;
  if (!r.taskId) return r.kind==='task_result'||goal.revision===r.revision;
  const task=goal.tasks.find(t=>t.id===r.taskId);
  return task && (r.kind==='task_result'?task.status!=='cancelled':task.status==='open'&&task.revision===r.revision);
}

function localResult(item,remote) {
  const n=item.payload.notification;
  if (remote!==false||!record(n)||!id(item.goalId)||!eventId(n.event_id)||
      !['recommendation_ready','task_result'].includes(n.kind)||!version(n.revision)||
      !freshResult(item.createdAt)||(item.taskId!=null&&!id(item.taskId))) return null;
  return {eventId:n.event_id,kind:n.kind,goalId:item.goalId,taskId:item.taskId??undefined,revision:n.revision,createdAt:item.createdAt};
}

export function createEventWorkspace({config,onChange=()=>{},onNotifications}) {
  if (!id(config?.userId)) throw Error('缺少服务端绑定用户');
  const key=`along.event-workspace.v1:${config.userId}`;
  let state=empty(config.userId),flight=null,lastError='',disposed=false;
  try {
    const saved=JSON.parse(localStorage.getItem(key));
    if (saved?.version===1&&saved.userId===config.userId&&version(saved.cursor)&&record(saved.goals)&&record(saved.messages)) {
      for (const [key,goal] of Object.entries(saved.goals)) {
        if (!record(goal)||key!==goal.id) throw Error('bad cache');
        saved.goals[key]=safeWorkspaceGoal({goal:{...goal,currentRevision:goal.revision},
          revision:{goalId:goal.id,revision:goal.revision,title:goal.title,status:goal.status,metric:goal.metric,context:goal.context},
          tasks:goal.tasks.map(task=>({...task,currentRevision:task.revision}))});
      }
      for (const [eventId,message] of Object.entries(saved.messages)) {
        if (!record(message)||message.eventId!==eventId||!text(message.text,2000)||
          !['user','assistant','system'].includes(message.role)||(message.goalId!==undefined&&!id(message.goalId))||
          (message.conversationId!==undefined&&!id(message.conversationId))) throw Error('bad cache');
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
      state=reconcileSelection(saved);
    }
  } catch { /* A damaged cache is rebuilt from the durable server outbox. */ }
  function save(next) {
    if (disposed) throw Error('连接已切换');
    const reconciled = reconcileSelection(next);
    localStorage.setItem(key, JSON.stringify(reconciled));
    state = reconciled;
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
    return {...next,draftScope:draftScope(next),error:lastError,messages:Object.values(next.messages).map(message=>({...message,
      status:failures.some(item=>item.event_id===message.eventId)?'rejected':pending.has(message.eventId)?'pending':message.status}))};
  }
  function draftScope(value=state) { return value.activeGoalId?`goal:${value.activeGoalId}`:`conversation:${value.conversationId??'new'}`; }
  function draft() { return state.drafts?.[draftScope()]??''; }
  function setDraft(value) {
    const clean=typeof value==='string'?value.slice(0,800):'';
    const drafts={...state.drafts};
    if (clean) drafts[draftScope()]=clean;
    else delete drafts[draftScope()];
    save({...state,drafts});
  }
  function select(goalId) {
    if (goalId!==null&&!isActiveGoal(state,goalId)) return;
    const returnGoalId=goalId===null
      ? (isActiveGoal(state,state.activeGoalId)?state.activeGoalId:state.returnGoalId)
      : goalId;
    // Reopening "new goal" resumes an unbound conversation. This preserves both its durable
    // messages and any follow-up draft written after the first send. Once the server binds that
    // conversation to a goal, the next "new goal" starts from a clean conversation instead.
    const conversationId=goalId===null&&conversationGoal(state)?null:state.conversationId;
    save({...state,activeGoalId:goalId,conversationId,returnGoalId});onChange();
  }
  function leaveConversation() {
    const returnGoalId=isActiveGoal(state,state.returnGoalId)?state.returnGoalId:null;
    // Keep conversationId and its durable outbox intact. A late Agent result must stay bound to
    // this conversation, while the goal the user returned to remains the visible selection.
    save({...state,activeGoalId:returnGoalId,returnGoalId});onChange();
    return returnGoalId;
  }
  async function submit(message) {
    if (!text(message,800)) throw Error('请输入 800 字以内的消息');
    const next=recoverPending();
    const composingScope=draftScope(next);
    const assembled=assembleEnvelope({event_type:'along.user_message',occurred_at:new Date().toISOString(),
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Shanghai',goal_id:next.activeGoalId??undefined,
      causation_id:next.activeGoalId===null?next.conversationId??undefined:undefined,
      payload:{event_type:'along.user_message',text:message}});
    if (!assembled.ok) throw Error(assembled.reason);
    const receipt=await queueEvent(config,assembled.envelope,{send:false});
    if (!receipt.ok) throw Error(receipt.reason);
    const root=next.conversationId??receipt.event_id;
    next.conversationId=root;
    next.drafts={...next.drafts};delete next.drafts[composingScope];
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
      const page=await agentCall(config,'/sync',{after_seq:state.cursor,limit:50,
        ...(onNotifications?{notificationFallback:true,notificationReceipts:receipts}:{})});
      if(disposed) return;
      if (!record(page)||!Array.isArray(page.items)||page.items.length>50) throw Error('同步响应格式不正确');
      const next=recoverPending(),seqs=[];
      const fallbacks=onNotifications?page.notificationFallback??[]:[];
      if (!Array.isArray(fallbacks)||fallbacks.length>50||fallbacks.some(r=>!validResult(r)||r.userId!==config.userId)) throw Error('通知补投格式不正确');
      if (fallbacks.length) {
        const pending=new Map((next.notificationResults??[]).map(r=>[r.eventId,r]));
        for (const r of fallbacks) pending.set(r.eventId,{eventId:r.eventId,kind:r.kind,goalId:r.goalId,taskId:r.taskId??undefined,
          revision:r.revision,createdAt:r.createdAt,fallback:true});
        next.notificationResults=[...pending.values()];
      }
      if (receipts.length) next.notificationReceipts=next.notificationReceipts.filter(id=>!receipts.includes(id));
      if (page.items.length===0) {
        if (page.nextCursor!==undefined) throw Error('同步分页游标不正确');
        if (fallbacks.length||receipts.length) save(next);
        break;
      }
      let previous=state.cursor;
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
        if (onNotifications) {
          const notice=localResult(item,item.remoteNotifications??page.remoteNotifications);
          if (notice) {
            const queue=next.notificationResults??[];
            if (!queue.some(r=>r.eventId===notice.eventId)) next.notificationResults=[...queue,notice];
          }
        }
        if (item.kind==='message') {
          const message=safeMessage(item.payload.message,item);
          next.messages[message.eventId]=message;
          if (item.goalId&&state.activeGoalId===null&&message.conversationId===state.conversationId) next.activeGoalId=item.goalId;
        }
        if (item.kind==='delivery_failed') {
          const eventId=item.payload.event_id;
          if (id(eventId)&&next.messages[eventId]) next.messages[eventId]={...next.messages[eventId],status:'failed'};
        }
      }
      if (page.nextCursor!==undefined&&String(page.nextCursor)!==String(previous)) throw Error('同步分页游标不正确');
      next.cursor=previous;next.pendingAck=seqs;
      save(next);onChange();
      // Cache commit precedes ack. A failed ack is retried before pulling further, without replaying data.
      await agentCall(config,'/sync/ack',{seqs});
      save({...state,pendingAck:[]});
      if (page.nextCursor===undefined) break;
    }
    if (onNotifications&&!disposed) {
      // Reconcile only a complete sync. A torn page, stale connection or offline cache must never withdraw other tasks.
      const active=Object.values(state.goals).filter(g=>g.status==='active');
      const reminders=active.flatMap(g=>g.tasks.filter(t=>t.status==='open'&&Date.parse(t.scheduledAt)>Date.now())
        .map(t=>({goalId:g.id,taskId:t.id,revision:t.revision,scheduledAt:new Date(t.scheduledAt).toISOString(),body:t.content})));
      const activeTasks=active.flatMap(g=>g.tasks.filter(t=>t.status==='open').map(t=>({goalId:g.id,taskId:t.id,revision:t.revision})));
      const queued=state.notificationResults??[];
      const results=queued.filter(r=>applicableResult(r,state.goals));
      await onNotifications({userId:config.userId,fingerprint:config.fingerprint,cursor:state.cursor,reminders,activeTasks,results});
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
  return {view,draft,setDraft,select,leaveConversation,submit,sync,dispose:()=>{disposed=true;}};
}
