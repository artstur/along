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
    ...(t?.kind==='reminder'?{scheduledFor:stamp(t.scheduledFor)&&/(Z|[+-]\d\d:\d\d)$/i.test(t.scheduledFor)?new Date(t.scheduledFor).toISOString():null}:{})}));
}

function privateTaskIds(value) {
  const declared=list(value?.protectedTaskIds,6);
  return list(value?.currentPlan?.tasks,6).filter(t=>t?.id&&(declared.includes(t.id)||
    (t.title==='本机保留的任务'&&t.detail==='任务内容来自旧授权范围，请保留。'))).map(t=>t.id);
}

// A standing instruction is a separate goal-scoped grant. Never infer it from
// a HealthKit read permission, a goal title, or the model's own output.
export function cleanDailyDelegation(value) {
  if (!value || typeof value.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value.id)||
      !(value.goalKey==='health'||typeof value.goalKey==='string'&&/^custom:[A-Za-z0-9_:-]{1,90}$/.test(value.goalKey))||
      !Array.isArray(value.topics)||!value.topics.length||value.topics.some(t=>!['sleep','workout'].includes(t))||
      new Set(value.topics).size!==value.topics.length) return null;
  const topics=['sleep','workout'].filter(t=>value.topics.includes(t));
  const weekly=value.weeklyWorkoutMinutes;
  if (weekly!=null&&(!topics.includes('workout')||!Number.isInteger(weekly)||weekly<1||weekly>10080)) return null;
  return {id:value.id,goalKey:value.goalKey,topics,...(weekly!=null?{weeklyWorkoutMinutes:weekly}:{})};
}

export function validateDailyActions(value,planning) {
  const grant=cleanDailyDelegation(planning?.dailyDelegation);
  const fields=['localDate','workoutMinutes','workoutReminderAt','sleepReminderAt','bedtimeAt','reason'];
  if (!grant||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||
      !fields.every(field=>Object.hasOwn(value,field))||value.localDate!==planning.localDate||
      typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>300) throw Error('每日安排的授权、日期或依据不完整');
  const {workoutMinutes,workoutReminderAt,sleepReminderAt,bedtimeAt}=value;
  if (workoutMinutes!==null&&(!Number.isInteger(workoutMinutes)||workoutMinutes<0||workoutMinutes>1440)||
      workoutReminderAt!==null&&!(workoutMinutes>0)||!grant.topics.includes('workout')&&(workoutMinutes!==null||workoutReminderAt!==null)||
      !grant.topics.includes('sleep')&&(sleepReminderAt!==null||bedtimeAt!==null)) throw Error('每日安排超出授权或运动分钟无效');
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:planning.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const now=Date.parse(planning.now);
  if (!Number.isFinite(now)||!planning.timezone||format.format(now)!==value.localDate) throw Error('每日评估的当地日期无效');
  const nextDate=new Date(Date.parse(value.localDate+'T00:00:00Z')+86400_000).toISOString().slice(0,10);
  for (const field of ['workoutReminderAt','sleepReminderAt','bedtimeAt']) {
    const time=value[field];
    if (time===null) continue;
    if (typeof time!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(time)||
        !(Date.parse(time)>now)) throw Error('每日时刻需要评估时刻之后的绝对时间');
    const day=format.format(Date.parse(time));
    if (day!==value.localDate&&!(field==='bedtimeAt'&&day===nextDate)) throw Error('每日提醒须落在评估所指的当地日期');
  }
  if (bedtimeAt&&sleepReminderAt&&Date.parse(bedtimeAt)<Date.parse(sleepReminderAt)) throw Error('就寝建议早于睡前提醒');
  return {...value,reason:value.reason.trim()};
}

export const DAILY_ACTIONS_CRITERIA=[
  'planning.dailyDelegation 是本人给当前目标的长期每日委托。只对 topics 中的项目生成今天的具体行动，不修改或重排旧任务来表达每日委托。仍然要独立评估原任务。一次明确的每日委托可与 keep 共存。',
  '依据获准汇总、最近负荷、本人约束及今天剩余时段决定今天从现在起建议再运动的分钟数、运动提醒、睡前收尾提醒和可选就寝时刻。不要机械平分周缺口，不把未记录当休息或当作零。用户提供的 weeklyWorkoutMinutes 是周目标。运动时段可参考本人已记录习惯，日程和入睡时间推测不得写成事实。',
  'recentDecisions 中 daily_actions 是同目标、同委托、同一天 DSH 已规划的分钟与时刻；动手前比对此项，若新证据不影响执行就保留原定时刻。改变时在 reason 说明依据，不重复已过的通知。',
  '两种提醒若能确定，应晚于 planning.now 且在 planning.timezone 的当日；提醒已安排时保留，勿声称已经投递。今日已无需再运动须有具体依据才填 0 且不另排运动提醒。不足以判断写 null，在 reply 里问一个有意义的问题。可选就寝时刻可以次日凌晨，且不可早于睡前收尾。没委托的项目必须是 null。',
  '在正常中文 reply 的最末另起一行，输出恰好一次 ALONG_DAILY_ACTIONS_V1 后加一个空格和单行 JSON 对象（无代码围栏）。全部字段必填：localDate=planning.localDate，workoutMinutes=非负整数或 null，workoutReminderAt/sleepReminderAt/bedtimeAt=带Z或UTC偏移的绝对ISO时刻或null，reason=简短中文依据及缺失。不要在 reassessment 或顶层新增字段。即使 keep 或 need_data 也提交这一行，整个 reply 限1200字。'
].join('\n');

export function parseDailyActionReply(run) {
  const raw=run.result.reply,p=run.input?.snapshot?.planning,grant=cleanDailyDelegation(p?.dailyDelegation);
  const lines=typeof raw==='string'?raw.trimEnd().split(/\r?\n/):[];
  const marker='ALONG_DAILY_ACTIONS_V1 ';
  const matches=lines.filter(line=>line.startsWith('ALONG_DAILY_ACTIONS_'));
  if (!grant&&!matches.length) return {reply:raw};
  if (!grant||run.actual!==true||run.kind!=='goal'||run.runtime!=='dsh-superagent'||run.status!=='done'||
      typeof run.ticket?.id!=='string'||!run.ticket.id.trim()||run.requestId!==p.revisionId||
      run.input.goal?.domain!==(grant.goalKey==='health'?'health':'custom')||
      run.input.snapshot.contextReviewAllowed!==true||!grant.topics.every(t=>run.input.snapshot.selectedTypes?.includes(t))||
      matches.length!==1||!lines.at(-1)?.startsWith(marker)) throw Error('未收到符合当前每日委托的 DSH 工单或行动记录');
  const dailyActions=validateDailyActions(JSON.parse(lines.pop().slice(marker.length)),p);
  return {reply:lines.join('\n').trim(),dailyActions};
}

export function cleanPlanningContext(value) {
  if (!value||value.version!==1) return null;
  const plan=value.currentPlan;
  const previous=cleanHealthContext(value.previous);
  const hasBaseline=previous.selectedTypes.length>0;
  const weekly=value.weeklyWorkoutMinutes;
  const dailyDelegation=cleanDailyDelegation(value.dailyDelegation);
  return {version:1,...(dailyDelegation?{dailyDelegation}:{}),kind:'context-review',revisionId:text(value.revisionId,96),
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

export function createPlanningContext({before,after,goalIntent,currentPlan,weeklyWorkoutMinutes=null,dailyDelegation=null,protectedTaskIds=[],recentDecisions=[],cause='observation',now=new Date(),revisionId}) {
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const previous=cleanHealthContext({...before,selectedTypes:(before?.selectedTypes||[]).filter(type=>after.selectedTypes.includes(type)),
    comparisonHistoryAllowed:before?.comparisonHistoryAllowed===true&&after.comparisonHistoryAllowed===true});
  return cleanPlanningContext({version:1,revisionId,cause,now:now.toISOString(),timezone,
    localDate:new Intl.DateTimeFormat('en-CA',{timeZone:timezone}).format(now),goalIntent,
    previous,changes:healthContextChanges(previous,after),currentPlan,weeklyWorkoutMinutes,dailyDelegation,protectedTaskIds,recentDecisions});
}

// Also evaluated in JavaScriptCore by the native HealthKit observer.
export function buildBackgroundReviewRequest(template,snapshot,requestId,clock) {
  const key=template?.goalKey,domain=key==='health'?'health':'custom';
  if (!(key==='health'||typeof key==='string'&&/^custom:[A-Za-z0-9_:-]{1,90}$/.test(key))||
      template.runtime!=='dsh-superagent'||template.paused||template.goal?.domain!==domain||
      snapshot?.contextReviewAllowed!==true||snapshot.backgroundReviewAllowed!==true||snapshot.backgroundReviewGoalKey!==key||
      typeof requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(requestId)||!stamp(clock?.now)||!text(clock.timezone,80)||!/^\d{4}-\d{2}-\d{2}$/.test(clock.localDate)) return null;
  const scope=template.selectedTypes;
  if (!Array.isArray(scope)||!scope.length||!Array.isArray(snapshot.selectedTypes)||!scope.every(type=>TYPES.includes(type)&&snapshot.selectedTypes.includes(type))||
      template.comparisonHistoryAllowed===true&&snapshot.comparisonHistoryAllowed!==true) return null;
  const selectedTypes=TYPES.filter(type=>scope.includes(type));
  const history=template.comparisonHistoryAllowed===true&&snapshot.comparisonHistoryAllowed===true;
  const after=agentHealthSnapshot({...snapshot,selectedTypes,comparisonHistoryAllowed:history});
  const source=cleanPlanningContext(template.planning);
  if (!source||!source.previous.selectedTypes.length||source.dailyDelegation&&(source.dailyDelegation.goalKey!==key||
      !source.dailyDelegation.topics.every(t=>selectedTypes.includes(t)))) return null;
  const previous=cleanHealthContext({...source.previous,selectedTypes:source.previous.selectedTypes.filter(t=>selectedTypes.includes(t)),
    comparisonHistoryAllowed:history&&source.previous.comparisonHistoryAllowed});
  const observed=Object.keys(METRICS).some(field=>after[field]!=null)||
    Object.values(after.recentHistory||{}).some(pair=>pair.recent.value!=null||pair.previous.value!=null);
  const changes=healthContextChanges(previous,after);
  const nextReview=stamp(template.nextReviewAt);
  const due=!!nextReview&&Date.parse(nextReview)<=Date.parse(clock.now);
  const knownDay=/^\d{4}-\d{2}-\d{2}$/.test(template.evaluatedLocalDate);
  const nextDay=knownDay?template.evaluatedLocalDate!==clock.localDate:!!source.dailyDelegation;
  if (!observed||!changes.length&&!due&&!nextDay) return null;
  // A same-day follow-up time may be due for the existing tasks even though
  // the daily agenda has no new evidence. Do not issue it a second time.
  const dailyDelegation=changes.length||nextDay?source.dailyDelegation:null;
  const planning=cleanPlanningContext({...source,previous,changes,dailyDelegation,cause:due||nextDay?'review':'observation',revisionId:requestId,
    now:clock.now,timezone:clock.timezone,localDate:clock.localDate});
  const goal={domain,title:text(template.goal.title,120),target:domain==='health'?planning.weeklyWorkoutMinutes:null};
  if (!goal.title) return null;
  return {requestId,runtime:template.runtime,goal,snapshot:{...after,planning},
    message:'请结合目标、已有安排和最新情境，评估是否需要调整；给出判断与任务变更依据。',history:[]};
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
    ...(value.dailyActions!=null?{dailyActions:validateDailyActions(value.dailyActions,planning)}:{}),
    watchFor:list(value.watchFor,8).map(v=>text(v,180)).filter(Boolean)};
}

// The Host attaches this same policy to both runtime inputs, including reviews
// from older clients. No private goal text or additional HealthKit field is needed.
export const SLEEP_REMINDER_CRITERIA=[
  '若本次可见的目标、任务或用户新要求明确涉及就寝作息，主动检查下一次睡前提醒。仅选择了睡眠读数不足以判断用户有此目标。protectedTaskIds 原样保留，不从占位任务猜测内容，也不把它当成已有等价提醒的证据。',
  '以当前 message 和 recentDecisions 中用户最新反馈为准。在 planning.timezone 下解释“今天、今晚”：message 重放反馈时沿用该条反馈的 at，只有新输入没有反馈时间戳才用 planning.now。晚睡可能跨午夜。一次性请求过了对应夜晚或已满足，不顺延或变成每日提醒。尊重拒绝、暂停和已采用的同一晚等价提醒，不重复提案。',
  '本次就寝目标确实需要提醒，且有足够依据时，即使健康读数没变也选择 revise，提出下一次有具体本地时刻的 kind=reminder，填写晚于 planning.now、带时区的 scheduledFor。优先使用本人指定时刻或明确的起床与睡眠时长目标。本人请你代选时，可依据授权睡眠摘要提出一个合理的收尾时点，在理由中说明依据和不确定性。单次入睡、睡眠结束或运动记录不能证明通常的起床、下班或日程。若明确要求今天收到，提醒本身要落在用户本地今天余下的时间内。',
  '有尚未满足的睡前提醒请求，只有缺少关键时间依据、时间已过或有具体冲突时才用 need_data，在 reply 中只问一个能确定下一步的问题。文字建议、watchFor、nextReviewAt 或 keep 都不能代替一次可采用的提醒。没有未满足的需要时可以 keep。提案由本人采用后才进入系统提醒队列。',
].join('\n');

export const REASSESSMENT_INSTRUCTIONS=`This is a contextual review of an existing goal, not a new goal assignment.
Compare the current observation with snapshot.planning.previous, the user's full goalIntent, existing tasks, recent decisions and feedback. The fact collector does NOT decide whether a change matters. You make that judgment, even when a weekly target is already met or a change is small.
Think across time: consider yesterday's load, today's sleep and wake timing, shifts in workout type/time/frequency, time remaining, commitments and available environmental evidence together. An unusual day is not automatically a lasting habit; separate an observation from an inferred pattern and from an explicit preference change. An observed earlier wake time does not silently rewrite a fixed wake-time constraint. State uncertainty and request useful missing sources. Do not invent calendar slots, bookings, weather, POIs, visits or medical diagnoses.
Apply snapshot.planning.reviewCriteria when choosing keep, revise or need_data. A keep decision stays quiet. For revise, return the complete updated layout (same schema), reuse task IDs for retained/updated tasks, and explain every add/update/cancel. Preserve unaffected commitments and completed work. Use Chinese user-facing text. Optimize the next one or two useful actions over the user's goal horizon; do not divide the remaining minutes mechanically or turn example weekdays into rules. Do not change the goal itself during this review: proposal=null. A review is planning authorization only; no booking, payment, publishing or other external write.
For revise use layout={"version":1,"title":"...","summary":"...","modules":[],"tasks":[...],"questions":[]}. Include at most six tasks. In layout.tasks list each retained task as {"id":"original-id"}. To update one, include only its id and the fields that need to change, e.g. {"id":"walk","state":"deferred"}. Along fills all other fields from the accepted plan. Omit cancelled IDs and explain the cancellation. For an added task supply id, when, title, detail, state (temporary|planned|deferred) and kind (reminder|recommendation|agent_action). Classify every real difference in reassessment.changes. Each new or updated reminder needs a scheduledFor strictly after planning.now, with timezone. Previously elapsed reminders can stay as history; never reschedule them merely to make a future timestamp. For need_data ask one actionable question in reply. Treat a user answer in recentDecisions as input to that question.
Return reassessment={"decision":"keep|revise|need_data","basedOnRevision":"snapshot.planning.revisionId","reason":"reason grounded in observed changes and goal tradeoffs","changes":[{"taskId":"stable id","operation":"add|update|cancel|keep","reason":"why"}],"nextReviewAt":"ISO time with UTC offset or null","watchFor":["conditions worth reconsidering"]} alongside reply, proposal and layout. For keep/need_data, layout=null and changes=[]. Choose the next useful review time yourself, or null. Do not claim a notification or other action was delivered.`;
