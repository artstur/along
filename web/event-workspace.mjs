import {agentCall, queueEvent, flushEventQueue, pendingEvents, readEventFailures} from './agent-client.mjs';
import {assembleEnvelope} from './event-envelope.mjs';
import {validateGoalReply} from './goal-agent-core.mjs';
import {safeAdaptiveLayout} from './adaptive-ui.mjs';

const id = value => typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const record = value => value!==null && typeof value==='object' && !Array.isArray(value);
const text = (value,max) => typeof value==='string' && value.trim().length>0 && value.length<=max;
const version = value => Number.isSafeInteger(value) && value>=0;
const time = value => typeof value==='string' && Number.isFinite(Date.parse(value));
const empty = userId => ({version:1,userId,cursor:0,goals:{},messages:{},activeGoalId:null,conversationId:null});

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
    replyToMessageId:message.replyToMessageId,presentation:item.payload.presentation,status:'received'};
}

export function createEventWorkspace({config,onChange=()=>{}}) {
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
      if (saved.activeGoalId!==null&&!id(saved.activeGoalId)||saved.conversationId!==null&&!id(saved.conversationId)||
          saved.pendingAck!==undefined&&(!Array.isArray(saved.pendingAck)||saved.pendingAck.some(seq=>!version(seq)||seq<1||seq>saved.cursor))) throw Error('bad cache');
      state=saved;
    }
  } catch { /* A damaged cache is rebuilt from the durable server outbox. */ }
  function save(next) { if(disposed) throw Error('连接已切换');localStorage.setItem(key,JSON.stringify(next));state=next; }
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
    return {...next,error:lastError,messages:Object.values(next.messages).map(message=>({...message,
      status:failures.some(item=>item.event_id===message.eventId)?'rejected':pending.has(message.eventId)?'pending':message.status}))};
  }
  function select(goalId) {
    if (goalId!==null&&!state.goals[goalId]) return;
    save({...state,activeGoalId:goalId,conversationId:goalId===null?null:state.conversationId});onChange();
  }
  async function submit(message) {
    if (!text(message,800)) throw Error('请输入 800 字以内的消息');
    const next=recoverPending();
    const assembled=assembleEnvelope({event_type:'along.user_message',occurred_at:new Date().toISOString(),
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Shanghai',goal_id:next.activeGoalId??undefined,
      causation_id:next.activeGoalId===null?next.conversationId??undefined:undefined,
      payload:{event_type:'along.user_message',text:message}});
    if (!assembled.ok) throw Error(assembled.reason);
    const receipt=await queueEvent(config,assembled.envelope,{send:false});
    if (!receipt.ok) throw Error(receipt.reason);
    const root=next.conversationId??receipt.event_id;
    next.conversationId=root;
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
      const page=await agentCall(config,'/sync',{after_seq:state.cursor,limit:50});
      if(disposed) return;
      if (!record(page)||!Array.isArray(page.items)||page.items.length>50) throw Error('同步响应格式不正确');
      if (page.items.length===0) {
        if (page.nextCursor!==undefined) throw Error('同步分页游标不正确');
        break;
      }
      const next=recoverPending(),seqs=[];
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
  }
  function sync() {
    if(disposed) return Promise.resolve();
    if (flight) return flight;
    const beforeError=lastError;
    flight=synchronize().then(()=>{lastError='';}).catch(error=>{lastError=error?.message||'同步未完成';})
      .finally(()=>{flight=null;if(!disposed&&lastError!==beforeError) onChange();});
    return flight;
  }
  return {view,select,submit,sync,dispose:()=>{disposed=true;}};
}
