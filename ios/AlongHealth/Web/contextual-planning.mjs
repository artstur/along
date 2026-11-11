// Facts and transport only. Whether a change matters, and what to do about it,
// are decisions made by the Super Agent, not thresholds in this module.
export const PLANNING_STATE_KEY='along.contextual-planning.v1';
const TYPES=['workout','steps','weight','sleep','activeEnergy','restingHeartRate','wristTemperature'];
const METRICS={workoutMinutes:['workout',10080],workoutCount:['workout',1000],sleepMinutes:['sleep',1440],
  steps:['steps',200000],weightKg:['weight',1000],activeEnergyKcal:['activeEnergy',20000],
  restingHeartRate:['restingHeartRate',250],wristTemperatureC:['wristTemperature',45]};
const number=(v,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:null;
const text=(v,max=300)=>typeof v==='string'?v.trim().slice(0,max):'';
const stamp=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v))?v:null;
const list=(v,max)=>Array.isArray(v)?v.slice(0,max):[];

// Local calendar weeks can cross a daylight-saving transition.
function historyWindow(value,type) {
  const startAt=stamp(value?.startAt),endAt=stamp(value?.endAt);
  if (!startAt||!endAt||![startAt,endAt].every(time=>/(Z|[+-]\d\d:\d\d)$/.test(time))) return null;
  const hours=(Date.parse(endAt)-Date.parse(startAt))/3_600_000;
  const daysWithData=value.daysWithData;
  if (Math.abs(hours-7*24)>2||!Number.isInteger(daysWithData)||daysWithData<0||daysWithData>7) return null;
  const max={sleep:1440,workout:10080,weight:1000}[type];
  const measured=daysWithData>0?number(value.value,max):null;
  const window={startAt,endAt,daysWithData,value:measured};
  if (type==='workout') window.count=daysWithData&&Number.isInteger(value.count)&&value.count>=daysWithData?number(value.count,1000):null;
  return window;
}

function recentHistory(raw,selectedTypes,capturedAt,comparisonHistoryAllowed) {
  const history={};
  for (const type of ['sleep','workout','weight']) {
    if (!selectedTypes.includes(type)||!raw?.[type]||(type!=='workout'&&!comparisonHistoryAllowed)) continue;
    const recent=historyWindow(raw[type].recent,type),previous=historyWindow(raw[type].previous,type);
    if (!recent||!previous||Date.parse(previous.endAt)!==Date.parse(recent.startAt)) continue;
    const age=Date.parse(capturedAt)-Date.parse(recent.endAt);
    if (!Number.isFinite(age)||age<0||age>26*3_600_000) continue;
    history[type]={recent,previous};
  }
  return Object.keys(history).length?history:null;
}

export function cleanHealthContext(value={}) {
  const selectedTypes=TYPES.filter(type=>Array.isArray(value?.selectedTypes)&&value.selectedTypes.includes(type));
  const next={source:'Apple Health 汇总',selectedTypes,capturedAt:stamp(value?.capturedAt||value?.updatedAt)};
  for (const [key,[type,max]] of Object.entries(METRICS)) next[key]=selectedTypes.includes(type)?number(value?.[key],max):null;
  next.sleepSummary=null;
  if (selectedTypes.includes('sleep')&&value?.sleepSummary&&typeof value.sleepSummary==='object') {
    const s=value.sleepSummary;
    next.sleepSummary={windowDays:number(s.windowDays,28),daysWithData:number(s.daysWithData,28),
      averageMinutes:number(s.averageMinutes,1440),latestWakeAt:stamp(s.latestWakeAt),
      latestSleepStartAt:stamp(s.latestSleepStartAt),latestNightMinutes:number(s.latestNightMinutes,1440),
      previousNightMinutes:number(s.previousNightMinutes,1440),wakeTimeSource:'last_recorded_sleep_end',
      averageThroughAt:stamp(s.averageThroughAt),latestWindowOpen:s.latestWindowOpen===true};
  }
  next.workoutSummary=null;
  if (selectedTypes.includes('workout')&&value?.workoutSummary&&typeof value.workoutSummary==='object') {
    const w=value.workoutSummary;
    next.workoutSummary={windowDays:number(w.windowDays,56),weekStartAt:stamp(w.weekStartAt),
      todayMinutes:number(w.todayMinutes,1440),todayCount:number(w.todayCount,100),yesterdayMinutes:number(w.yesterdayMinutes,1440),
      latestWorkoutAt:stamp(w.latestWorkoutAt),patterns:list(w.patterns,40).map(p=>({
        activity:text(p?.activity,50),weekday:number(p?.weekday,7),hour:number(p?.hour,23),
        count:number(p?.count,100),recentCount:number(p?.recentCount,100),averageMinutes:number(p?.averageMinutes,1440),lastObservedAt:stamp(p?.lastObservedAt),
      })).filter(p=>p.activity&&p.count!==null)};
  }
  next.comparisonHistoryAllowed=value?.comparisonHistoryAllowed===true;
  next.recentHistory=recentHistory(value?.recentHistory,selectedTypes,next.capturedAt,next.comparisonHistoryAllowed);
  return next;
}

// Earlier releases only offered to share the selected weekly exercise total.
export function agentHealthSnapshot(value) {
  if (value?.contextReviewAllowed===true) return {...cleanHealthContext(value),contextReviewAllowed:true};
  const workout=Array.isArray(value?.selectedTypes)&&value.selectedTypes.includes('workout');
  return {selectedTypes:workout?['workout']:[],workoutMinutes:workout?number(value.workoutMinutes,10080):null};
}

// Fresh collection time alone is not a changed situation. Missing data stays
// null: it must never be interpreted as no exercise or no sleep.
export function healthContextChanges(before,after) {
  const a=cleanHealthContext(before),b=cleanHealthContext(after);
  return Object.keys(b).filter(key=>!['source','capturedAt'].includes(key)&&JSON.stringify(a[key])!==JSON.stringify(b[key]))
    .map(field=>({field,before:a[field],after:b[field]}));
}

function cleanTasks(tasks) {
  return list(tasks,6).map(t=>({id:text(t?.id,64),when:text(t?.when,80),title:text(t?.title,100),
    detail:text(t?.detail,300),state:['temporary','planned','deferred'].includes(t?.state)?t.state:'planned',
    ...(['reminder','agent_action','recommendation'].includes(t?.kind)?{kind:t.kind}:{}),
    ...(t?.kind==='reminder'?{scheduledFor:stamp(t.scheduledFor)?new Date(t.scheduledFor).toISOString():null}:{})}));
}

function privateTaskIds(value) {
  const declared=list(value?.protectedTaskIds,6);
  return list(value?.currentPlan?.tasks,6).filter(t=>t?.id&&(declared.includes(t.id)||
    (t.title==='本机保留的任务'&&t.detail==='任务内容来自旧授权范围，请保留。'))).map(t=>t.id);
}

export function cleanPlanningContext(value) {
  if (!value||value.version!==1) return null;
  const plan=value.currentPlan;
  const previous=cleanHealthContext(value.previous);
  const hasBaseline=previous.selectedTypes.length>0;
  const weekly=value.weeklyWorkoutMinutes;
  return {version:1,kind:'context-review',revisionId:text(value.revisionId,96),
    cause:['observation','review','feedback'].includes(value.cause)?value.cause:'observation',
    now:stamp(value.now),timezone:text(value.timezone,80),localDate:text(value.localDate,10),
    goalIntent:text(value.goalIntent,1600),
    previous,baselineKind:hasBaseline?'previous_observation':'initial',
    changes:hasBaseline?list(value.changes,16).map(c=>text(c?.field||c,80)).filter(Boolean):[],
    weeklyWorkoutMinutes:Number.isInteger(weekly)&&weekly>0&&weekly<=10080?weekly:null,
    protectedTaskIds:privateTaskIds(value),
    currentPlan:{title:text(plan?.title,80),summary:text(plan?.summary,600),tasks:cleanTasks(plan?.tasks)},
    recentDecisions:list(value.recentDecisions,6).map(d=>({at:stamp(d?.at),decision:text(d?.decision,20),
      reason:text(d?.reason,500),feedback:text(d?.feedback,300),watchFor:list(d?.watchFor,8).map(v=>text(v,180)).filter(Boolean)})),
  };
}

export function createPlanningContext({before,after,goalIntent,currentPlan,weeklyWorkoutMinutes=null,protectedTaskIds=[],recentDecisions=[],cause='observation',now=new Date(),revisionId}) {
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const previous=cleanHealthContext({...before,selectedTypes:(before?.selectedTypes||[]).filter(type=>after.selectedTypes.includes(type)),
    comparisonHistoryAllowed:before?.comparisonHistoryAllowed===true&&after.comparisonHistoryAllowed===true});
  return cleanPlanningContext({version:1,revisionId,cause,now:now.toISOString(),timezone,
    localDate:new Intl.DateTimeFormat('en-CA',{timeZone:timezone}).format(now),goalIntent,
    previous,changes:healthContextChanges(previous,after),currentPlan,weeklyWorkoutMinutes,protectedTaskIds,recentDecisions});
}

export function validateReassessment(value,layout,planning) {
  if (!planning) return null;
  if (!value||!['keep','revise','need_data'].includes(value.decision)||typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>600) throw Error('Agent 未给出有效的情境判断');
  if (value.decision==='revise'&&!layout) throw Error('重排需要完整的新任务空间');
  if (value.decision!=='revise'&&layout) throw Error('保留计划或等待数据时不能替换任务空间');
  if (value.basedOnRevision!==planning.revisionId) throw Error('重排结果与当前情境版本不一致');
  if (!Array.isArray(value.changes)||value.changes.length>12) throw Error('任务变更列表无效');
  const nextReviewAt=value.nextReviewAt==null?null:stamp(value.nextReviewAt);
  if (value.nextReviewAt!=null&&(!nextReviewAt||Date.parse(nextReviewAt)<=Date.parse(planning.now))) throw Error('下次复查时间无效');
  const changes=list(value.changes,12).map(c=>{
    if (!['add','update','cancel','keep'].includes(c?.operation)||!text(c?.taskId,64)||!text(c?.reason,300)) throw Error('任务变更依据不完整');
    return {taskId:text(c.taskId,64),operation:c.operation,reason:text(c.reason,300)};
  });
  const old=new Map(cleanTasks(planning.currentPlan?.tasks).map(t=>[t.id,t]));
  const next=new Map(cleanTasks(layout?.tasks).map(t=>[t.id,t]));
  if (new Set(changes.map(c=>c.taskId)).size!==changes.length) throw Error('任务变更重复');
  for (const change of changes) {
    if (change.operation==='add'&&(old.has(change.taskId)||!next.has(change.taskId))) throw Error('新增任务与任务空间不一致');
    if (change.operation==='cancel'&&(!old.has(change.taskId)||next.has(change.taskId))) throw Error('取消任务与任务空间不一致');
    if (['keep','update'].includes(change.operation)&&(!old.has(change.taskId)||!next.has(change.taskId))) throw Error('变更任务与任务空间不一致');
  }
  if (value.decision==='revise') {
    const protectedIds=new Set(privateTaskIds(planning));
    for (const id of new Set([...old.keys(),...next.keys()])) {
      const operation=!old.has(id)?'add':!next.has(id)?'cancel':JSON.stringify(old.get(id))===JSON.stringify(next.get(id))?'keep':'update';
      if (protectedIds.has(id)&&operation!=='keep') throw Error('本机保留的旧任务必须原样保留');
      const task=next.get(id);
      if (operation!=='keep'&&task?.kind==='reminder'&&!(Date.parse(task.scheduledFor)>Date.parse(planning.now))) throw Error('新增或更新的提醒需要未来时间');
      const claimed=changes.find(c=>c.taskId===id)?.operation;
      if ((claimed||'keep')!==operation) throw Error('任务空间存在未解释的变更');
    }
  } else if (changes.length) throw Error('未重排时不能声明任务变更');
  return {decision:value.decision,basedOnRevision:value.basedOnRevision,reason:value.reason.trim(),changes,nextReviewAt,
    watchFor:list(value.watchFor,8).map(v=>text(v,180)).filter(Boolean)};
}

export const REASSESSMENT_INSTRUCTIONS=`This is a contextual review of an existing goal, not a new goal assignment.
Compare the current observation with snapshot.planning.previous, the user's full goalIntent, existing tasks, recent decisions and feedback. The fact collector does NOT decide whether a change matters. You make that judgment, even when a weekly target is already met or a change is small.
Think across time: consider yesterday's load, today's sleep and wake timing, shifts in workout type/time/frequency, time remaining, commitments and available environmental evidence together. An unusual day is not automatically a lasting habit; separate an observation from an inferred pattern and from an explicit preference change. An observed earlier wake time does not silently rewrite a fixed wake-time constraint. State uncertainty and request useful missing sources. Do not invent calendar slots, bookings, weather, POIs, visits or medical diagnoses.
Choose keep, revise or need_data. Keep is a valid intelligent outcome and must stay quiet. For revise, return the complete updated layout (same schema), reuse task IDs for retained/updated tasks, and explain every add/update/cancel. Preserve unaffected commitments and completed work. Use Chinese user-facing text. Optimize the next one or two useful actions over the user's goal horizon; do not divide the remaining minutes mechanically or turn example weekdays into rules. Do not change the goal itself during this review: proposal=null. A review is planning authorization only; no booking, payment, publishing or other external write.
For revise use layout={"version":1,"title":"...","summary":"...","modules":[],"tasks":[...],"questions":[]}. Include at most six tasks. In layout.tasks list each retained task as {"id":"original-id"}. To update one, include only its id and the fields that need to change, e.g. {"id":"walk","state":"deferred"}. Along fills all other fields from the accepted plan. Omit cancelled IDs and explain the cancellation. For an added task supply id, when, title, detail, state (temporary|planned|deferred) and kind (reminder|recommendation|agent_action). Classify every real difference in reassessment.changes. Each new or updated reminder needs a scheduledFor strictly after planning.now, with timezone. Previously elapsed reminders can stay as history; never reschedule them merely to make a future timestamp. For need_data ask one actionable question in reply. Treat a user answer in recentDecisions as input to that question.
Return reassessment={"decision":"keep|revise|need_data","basedOnRevision":"snapshot.planning.revisionId","reason":"reason grounded in observed changes and goal tradeoffs","changes":[{"taskId":"stable id","operation":"add|update|cancel|keep","reason":"why"}],"nextReviewAt":"ISO time with UTC offset or null","watchFor":["conditions worth reconsidering"]} alongside reply, proposal and layout. For keep/need_data, layout=null and changes=[]. Choose the next useful review time yourself, or null. Do not claim a notification or other action was delivered.`;
