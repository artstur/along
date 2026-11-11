// node examples/guangzhou-health-replay.mjs                     # source observations and timeline
// node examples/guangzhou-health-replay.mjs --stage short-sleep # Along/DSH goal request on stdout
// --plan FILE accepts a previously adopted layout. --run-tag NAME starts a distinct replay.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {agentHealthSnapshot,cleanPlanningContext,createPlanningContext} from '../web/contextual-planning.mjs';
import {validateAdaptiveLayout} from '../web/adaptive-ui.mjs';
import {createGoalSuperAgentRequest} from '../web/super-agent.mjs';

const minute=60_000,day=1_440*minute;
const at=(date,time)=>date+'T'+time+':00+08:00';
const iso=ms=>new Date(ms).toISOString();
const dayOf=ms=>iso(ms+8*60*minute).slice(0,10);
const midnight=ms=>Date.parse(at(dayOf(ms),'00:00'));
const weekday=ms=>new Date(ms+8*60*minute).getUTCDay()||7;
const minutes=(from,to)=>Math.round((Date.parse(to)-Date.parse(from))/minute);

export const profile={
  synthetic:true,city:'广州',timezone:'Asia/Shanghai',
  person:'小许，天河区居民。产品上线期间有时需要凌晨收工，喜欢小班瑜伽，也喜欢周末与朋友走山路。',
  goal:'我希望近 7 天平均每晚睡满 8 小时，通常固定 11 点起床，每周运动累计 180 分钟。若出现更早的离床记录，请先分清临时安排和习惯变化。',
  preferences:'中午可以去公司附近练瑜伽。若周末时间和天气允许，喜欢公共交通能到、自己还没去过的徒步地点。约课或报名之前先问我。',
};

// One uninterrupted, already de-duplicated asleep interval per observed night in this fixture.
const nights=[
  ['2026-11-03','03:12','10:58'],['2026-11-04','02:54','11:04'],['2026-11-05','03:22','10:56'],
  ['2026-11-06','03:18','11:05'],['2026-11-07','02:46','11:11'],['2026-11-08','03:15','11:07'],
  ['2026-11-09','03:02','11:01'],['2026-11-10','03:10','11:02'],['2026-11-11','03:07','10:58'],
  ['2026-11-12','04:05','08:55'],['2026-11-13','03:00','11:06'],
].map(([date,start,end])=>({start:at(date,start),end:at(date,end)}));
// Listed sessions are the complete synthetic workout log for the replay window.
const workouts=[
  ['2026-10-13','12:10','瑜伽',45],['2026-10-16','12:15','瑜伽',45],['2026-10-17','10:20','徒步',70],
  ['2026-10-19','12:10','瑜伽',46],['2026-10-20','12:10','瑜伽',44],['2026-10-22','20:15','步行',25],
  ['2026-10-23','12:15','瑜伽',45],['2026-10-26','12:10','瑜伽',46],['2026-10-27','12:10','瑜伽',45],
  ['2026-10-29','19:10','瑜伽',30],['2026-10-31','09:15','徒步',80],['2026-11-02','12:10','瑜伽',45],
  ['2026-11-03','12:10','瑜伽',42],['2026-11-05','19:10','瑜伽',30],['2026-11-06','19:15','瑜伽',42],
  ['2026-11-09','12:10','瑜伽',45],['2026-11-10','12:10','瑜伽',50],['2026-11-11','18:05','骑行',100],
  ['2026-11-12','19:10','瑜伽',25],
].map(([date,time,activity,duration])=>({start:at(date,time),activity,minutes:duration}));

// These are time-stamped test fixtures, not live calendar, weather or map results.
const evidence=[
  {id:'schedule',source:'测试日历副本',observedAt:at('2026-11-11','21:15'),
    detail:'11 月 12 日 09:30–10:00 有一次交付会。日历只覆盖这次会议，其余空档与次日起床意图未知。'},
  {id:'class',source:'用户提供的测试课表',observedAt:at('2026-11-12','19:50'),
    detail:'11 月起周四 19:10 有晚间舒缓瑜伽，午休班仍在课表中。未来席位、实时课程、偏好是否永久改变未确认。'},
  {id:'weekend',source:'测试日历及本人周末留言',observedAt:at('2026-11-13','16:10'),
    detail:'周六上午需陪家人，周日 09:00–15:00 可出门。周日 16:00 需回到天河。'},
  {id:'visits',source:'本人的测试到访清单',observedAt:at('2026-11-13','16:20'),
    detail:'本人只针对三个地点确认：去过白云山与大夫山，没有去过火炉山；其他地点未知。没有 GPS 轨迹。'},
  {id:'weather',source:'广州测试天气快照',observedAt:at('2026-11-13','17:40'),
    detail:'适用 11 月 14–15 日；周六上午阵雨概率 75%，周日 09–13 时多云、21–26℃、阵雨概率 20%。山地逐时实况和临行预警未知。'},
  {id:'poi',source:'测试 POI 摘录',observedAt:at('2026-11-13','17:50'),
    detail:'备选火炉山森林公园南门、白云山南门、大夫山森林公园北门。火炉山有山路台阶。未提供轨迹长度、实时开放状态、公共交通换乘或往返耗时。'},
];
const sourceLabels={schedule:'当周日历',class:'瑜伽课表',weekend:'周末空闲',visits:'到访史',weather:'天气',poi:'地点'};
export const stages=[
  {id:'baseline',at:at('2026-11-09','18:30'),signal:'7 个已关闭的睡眠日，以及截至周一的 28 天运动汇总'},
  {id:'over-goal',at:at('2026-11-11','20:10'),signal:'周三长时间骑行已同步'},
  {id:'short-sleep',at:at('2026-11-12','09:05'),signal:'次日出现短睡和更早的睡眠结束记录'},
  {id:'habit-shift',at:at('2026-11-12','20:05'),signal:'第三个周四晚上出现瑜伽记录，课表已更新'},
  {id:'friday-weekend',at:at('2026-11-13','18:20'),signal:'周末空闲、到访史、预报及 POI 摘录已到达'},
];
const acceptedPlan={
  version:1,title:'睡眠与运动',summary:'小许在回放开始前确认的两个待办。',modules:[],questions:[],
  tasks:[
    {id:'wind-down',when:'周四凌晨 02:30',title:'结束工作，开始收尾',detail:'我在本周初自己设定的收尾提醒。',
      kind:'reminder',state:'planned',scheduledFor:at('2026-11-12','02:30')},
    {id:'weekend-window',when:'本周五傍晚',title:'看看周末能不能去徒步',detail:'先看空闲和天气，再和朋友商量。',kind:'recommendation',state:'planned'},
  ],
};

function sleepFacts(now) {
  const today=midnight(now);
  const cutoff=today+18*60*minute;
  const through=now<cutoff?cutoff-day:cutoff;
  const available=nights.filter(n=>Date.parse(n.end)<=now);
  const completed=available.filter(n=>Date.parse(n.end)>through-7*day&&Date.parse(n.end)<=through);
  const latest=available.find(n=>Date.parse(n.end)>cutoff-day&&Date.parse(n.end)<=cutoff);
  const previous=available.find(n=>Date.parse(n.end)>cutoff-2*day&&Date.parse(n.end)<=cutoff-day);
  const duration=n=>n?minutes(n.start,n.end):null;
  return {windowDays:7,daysWithData:completed.length,
    averageMinutes:completed.length?Math.floor(completed.reduce((sum,n)=>sum+duration(n),0)/completed.length):null,
    averageThroughAt:iso(through),latestWindowOpen:now<cutoff,latestNightMinutes:duration(latest),
    previousNightMinutes:duration(previous),latestSleepStartAt:latest?.start??null,latestWakeAt:latest?.end??null};
}

function healthFacts(stage) {
  const now=Date.parse(stage.at),today=midnight(now),weekStart=today-(weekday(now)-1)*day;
  const recent=workouts.filter(w=>Date.parse(w.start)>=today-27*day&&Date.parse(w.start)+w.minutes*minute<=now);
  const week=recent.filter(w=>Date.parse(w.start)>=weekStart);
  const onDay=offset=>recent.filter(w=>midnight(Date.parse(w.start))===today-offset*day);
  const total=list=>list.reduce((sum,w)=>sum+w.minutes,0);
  const groups=Map.groupBy(recent,w=>[w.activity,weekday(Date.parse(w.start)),w.start.slice(11,13)].join('/'));
  const patterns=Array.from(groups.values(),sessions=>{
    const last=sessions.at(-1);
    return {activity:last.activity,weekday:weekday(Date.parse(last.start)),hour:Number(last.start.slice(11,13)),
      count:sessions.length,recentCount:sessions.filter(w=>Date.parse(w.start)>=today-6*day).length,
      averageMinutes:Math.floor(total(sessions)/sessions.length),lastObservedAt:iso(midnight(Date.parse(last.start)))};
  }).sort((a,b)=>b.lastObservedAt.localeCompare(a.lastObservedAt));
  const sleepSummary=sleepFacts(now);
  return agentHealthSnapshot({contextReviewAllowed:true,selectedTypes:['sleep','workout'],capturedAt:stage.at,
    workoutCount:week.length,workoutMinutes:total(week),sleepMinutes:sleepSummary.latestNightMinutes,sleepSummary,
    workoutSummary:{windowDays:28,weekStartAt:iso(weekStart),todayMinutes:total(onDay(0)),todayCount:onDay(0).length,
      yesterdayMinutes:total(onDay(1)),latestWorkoutAt:recent.at(-1)?.start??null,patterns}});
}

function availableEvidence(stage) {
  const available=evidence.filter(e=>Date.parse(e.observedAt)<=Date.parse(stage.at));
  const missing=Object.entries(sourceLabels).filter(([id])=>!available.some(e=>e.id===id)).map(([,label])=>label);
  return {available,missing};
}

export function makeRequest(stageId,{currentPlan=acceptedPlan,recentDecisions=[],runTag=''}={}) {
  const index=stages.findIndex(s=>s.id===stageId);
  if (index<0) throw Error('未知阶段，可选 '+stages.map(s=>s.id).join(', '));
  const stage=stages[index],after=healthFacts(stage),before=index?healthFacts(stages[index-1]):null;
  const {available,missing}=availableEvidence(stage);
  const plan=validateAdaptiveLayout(currentPlan,'health');
  const history=available.map(e=>({role:'user',text:'[合成回放材料] '+e.source+'，采集于 '+e.observedAt+'。'+e.detail}));
  const message='合成数据回放，仅评估，不预约、不推送。'+profile.person+profile.preferences+
    '本次观测：'+stage.signal+'。未提供的来源：'+(missing.join('、')||'见每份材料中注明的缺口')+'。结合已有安排和证据判断是否需要调整，说明依据。';
  const hash=createHash('sha256').update(JSON.stringify({after,before,plan,history,message,recentDecisions,runTag})).digest('hex').slice(0,14);
  const revisionId='along-review-gz-'+stage.id+'-'+hash;
  const localPlanning=createPlanningContext({before,after,goalIntent:profile.goal,currentPlan:plan,recentDecisions,
    now:new Date(stage.at),revisionId,cause:stage.id==='friday-weekend'?'review':'observation'});
  const planning=cleanPlanningContext({...localPlanning,timezone:profile.timezone,localDate:stage.at.slice(0,10)});
  return createGoalSuperAgentRequest({requestId:revisionId,domain:'health',goal:{title:'睡眠与运动',target:180},
    snapshot:{...after,planning,synthetic:true},message,history});
}

if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const {values}=parseArgs({options:{stage:{type:'string'},plan:{type:'string'},'run-tag':{type:'string'}}});
    if (!values.stage&&(values.plan||values['run-tag'])) throw Error('--plan 和 --run-tag 需要指定 --stage');
    const result=values.stage?makeRequest(values.stage,{runTag:values['run-tag'],
      currentPlan:values.plan?JSON.parse(readFileSync(values.plan,'utf8')):acceptedPlan}):{
      profile,scope:'全量合成样本；没有读取真实健康、日历、到访、天气或地图数据。各阶段默认沿用同一份用户已确认的初始安排；只有实际采用新安排后才传入 --plan。',
      healthSource:{observedFrom:at('2026-10-13','00:00'),observedThrough:stages.at(-1).at,
        provenance:'仿 Apple Health 的合成记录；请求只含分组汇总。睡眠日 18:00 关窗，结束时间是睡眠记录边界。运动分组的近期计数窗口为 7 天。'},
      nights,workouts,evidence,acceptedPlan,stages:stages.map(s=>({...s,availableSources:availableEvidence(s).available.map(e=>e.id),missingSources:availableEvidence(s).missing})),
    };
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } catch(error) { process.stderr.write(error.message+'\n');process.exitCode=1; }
}
