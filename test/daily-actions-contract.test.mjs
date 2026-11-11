import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as policy from '../web/contextual-planning.mjs';
import * as goal from '../web/goal-agent-core.mjs';
import * as layout from '../web/adaptive-ui.mjs';

const grant={id:'delegate-0123',goalKey:'health',topics:['sleep','workout'],weeklyWorkoutMinutes:120};
const planning={version:1,revisionId:'along-daily-1',now:'2026-11-11T11:00:00Z',timezone:'Asia/Shanghai',localDate:'2026-11-11',dailyDelegation:grant,currentPlan:{tasks:[]}};
const actions={localDate:planning.localDate,workoutMinutes:15,workoutReminderAt:'2026-11-11T20:15:00+08:00',sleepReminderAt:'2026-11-11T23:15:00+08:00',bedtimeAt:'2026-11-12T00:05:00+08:00',reason:'本周尚有余量，今晚保留睡前收尾时间。'};
const reply='按今天的记录安排。';
const wire=value=>reply+'\nALONG_DAILY_ACTIONS_V1 '+JSON.stringify(value);
const run={actual:true,kind:'goal',runtime:'dsh-superagent',status:'done',requestId:planning.revisionId,ticket:{id:'ticket-1'},
  input:{goal:{domain:'health'},snapshot:{contextReviewAllowed:true,selectedTypes:['workout','sleep'],planning}},
  result:{reply:wire(actions),layout:null,proposal:null,reassessment:{decision:'keep',basedOnRevision:planning.revisionId,reason:'保留原任务。',changes:[],nextReviewAt:null,watchFor:[]}}};
const host=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');
const normalize=vm.runInNewContext(host.slice(host.indexOf('function normalizeGoalRun'),host.indexOf('const server=createServer'))+'\nnormalizeGoalRun',{...goal,...layout,...policy});

test('a real authorized DSH keep can carry today’s independent actions through the existing reply schema',()=>{
  assert.deepEqual(policy.cleanPlanningContext(planning).dailyDelegation,grant);
  const normalized=normalize(run);
  assert.equal(normalized.result.reply,reply);
  assert.deepEqual({...normalized.result.reassessment.dailyActions},actions);
  assert.equal(normalized.result.layout,null);
  assert.equal(normalized.ticket.id,'ticket-1');
});

test('a delegated response must match input scope, day, unit, future local reminder times and ticket',()=>{
  for (const value of [{...actions,localDate:'2026-11-12'},{...actions,workoutMinutes:'15'},{...actions,workoutMinutes:-1},
    {...actions,workoutReminderAt:'2026-11-11T20:15:00'},{...actions,sleepReminderAt:'2026-11-12T00:01:00+08:00'},
    {...actions,bedtimeAt:'2026-11-11T22:00:00+08:00'},{...actions,workoutReminderAt:'2026-11-11T18:00:00+08:00'},
    {...actions,workoutMinutes:0},{...actions,rawSample:'private'}]) {
    assert.throws(()=>policy.validateDailyActions(value,planning));
  }
  assert.throws(()=>policy.validateDailyActions(actions,{...planning,dailyDelegation:{...grant,topics:['sleep']}}));
  const noWorkout={...actions,workoutMinutes:null,workoutReminderAt:null};
  assert.deepEqual(policy.validateDailyActions(noWorkout,{...planning,dailyDelegation:{id:grant.id,goalKey:'health',topics:['sleep']}}),noWorkout);
  assert.deepEqual(policy.validateDailyActions({...actions,workoutMinutes:0,workoutReminderAt:null},planning),{...actions,workoutMinutes:0,workoutReminderAt:null});
  for (const bad of [{ticket:null},{actual:false},{runtime:'kimi-code-swarm'},{requestId:'other'},
    {input:{...run.input,snapshot:{...run.input.snapshot,planning:{...planning,dailyDelegation:null}}}},
    {input:{...run.input,snapshot:{...run.input.snapshot,selectedTypes:['sleep']}}},
    {result:{...run.result,reply:reply}},{result:{...run.result,reply:wire(actions)+'\n'+wire(actions)}}]) {
    assert.equal(normalize({...run,...bad}).status,'blocked');
  }
  const prior={...run,input:{...run.input,snapshot:{...run.input.snapshot,planning:{...planning,dailyDelegation:null}}},
    result:{...run.result,reply:'用户今日运动 45 分钟，23 点开提醒。'}};
  assert.equal(normalize(prior).status,'done');
  assert.ok(!normalize(prior).result.reassessment.dailyActions);
});

test('background daily reviews use only the selected goal and topics, deduplicate a same-day clinical follow-up, and renew after midnight',()=>{
  const sample={contextReviewAllowed:true,selectedTypes:['workout','sleep'],workoutMinutes:52,sleepMinutes:410,capturedAt:planning.now,
    backgroundReviewAllowed:true,backgroundReviewGoalKey:'health'};
  const template={goalKey:'health',runtime:'dsh-superagent',selectedTypes:sample.selectedTypes,
    goal:{domain:'health',title:'我的健康目标'},evaluatedLocalDate:planning.localDate,nextReviewAt:'2026-11-11T10:59:00Z',
    planning:{...planning,previous:sample}};
  const build=(t,s,now,localDate)=>policy.buildBackgroundReviewRequest(t,s,'along-review-native',{now,localDate,timezone:planning.timezone});
  assert.ok(!build(template,sample,planning.now,planning.localDate).snapshot.planning.dailyDelegation);
  const first=build({...template,evaluatedLocalDate:null,nextReviewAt:null},sample,planning.now,planning.localDate);
  assert.deepEqual(first.snapshot.planning.dailyDelegation,grant);
  assert.equal(build({...template,evaluatedLocalDate:null,nextReviewAt:null,planning:{...template.planning,dailyDelegation:null}},sample,planning.now,planning.localDate),null);
  const next=build(template,sample,'2026-11-12T01:00:00Z','2026-11-12');
  assert.deepEqual(next.snapshot.planning.dailyDelegation,grant);
  assert.deepEqual(build(template,{...sample,workoutMinutes:57},planning.now,planning.localDate).snapshot.planning.dailyDelegation,grant);
  assert.equal(build({...template,planning:{...template.planning,dailyDelegation:{...grant,goalKey:'custom:other'}}},sample,planning.now,planning.localDate),null);
});


test('the paired Host remembers only verified current-day figures, and older status queries cannot replace a later decision',async()=>{
  const {rememberDailyAction,includeEarlierDailyAction}=await import('../host/daily-action-history.mjs');
  const {mkdtempSync,readFileSync,statSync,readdirSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'along-daily-history-')),pair='a'.repeat(64),now=Date.parse(planning.now)+150000;
  try {
    const old=normalize(run);
    rememberDailyAction(dir,pair,old,now);
    const next=structuredClone(old);
    next.requestId='newer';next.input.snapshot.planning.revisionId='newer';next.input.snapshot.planning.now=new Date(now-30000).toISOString();
    next.result.reassessment.dailyActions.workoutMinutes=11;
    rememberDailyAction(dir,pair,next,now);
    rememberDailyAction(dir,pair,old,now);
    const request=()=>{const s=structuredClone(old.input.snapshot);s.planning.now=new Date(now).toISOString();s.planning.revisionId='another';return s;};
    const fresh=request();includeEarlierDailyAction(dir,pair,fresh,now);
    assert.equal(fresh.planning.recentDecisions.length,1);
    assert.equal(JSON.parse(fresh.planning.recentDecisions[0].reason).workoutMinutes,11);
    const file=join(dir,'current-daily-actions.json'),raw=readFileSync(file,'utf8');
    assert.equal(statSync(file).mode&0o777,0o600);
    assert.doesNotMatch(raw,/今天|本周|我的|Apple Health|delegate-0123|sleepMinutes|currentPlan/);
    for (const [otherPair,mutate] of [['b'.repeat(64),()=>{}],[pair,s=>s.planning.dailyDelegation.id='different'],
      [pair,s=>s.selectedTypes=['sleep']],[pair,s=>s.comparisonHistoryAllowed=true]]) {
      const wrong=request();mutate(wrong);includeEarlierDailyAction(dir,otherPair,wrong,now);
      assert.ok(!wrong.planning.recentDecisions?.length);
    }
    const tomorrow=request();includeEarlierDailyAction(dir,pair,tomorrow,now+86400000);
    assert.deepEqual(readdirSync(dir),[]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
