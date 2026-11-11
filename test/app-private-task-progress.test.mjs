import {ACTIVE_GOAL_KEY} from '../web/workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {KEY} from '../web/health.mjs';
import {ADAPTIVE_LAYOUTS_KEY} from '../web/adaptive-ui.mjs';
import {AGENT_KEY,GOALS_KEY} from '../web/agent-client.mjs';
import {PLANNING_STATE_KEY} from '../web/contextual-planning.mjs';
import {DSH_RUNTIME} from '../web/super-agent.mjs';

const goal={title:'原来的十二周健康目标'};
const task={id:'local-workout',when:'每周持续',title:'累计运动至少120分钟',detail:'保留原任务私有内容',state:'planned'};
const other={...task,id:'daily',title:'单次运动至少120分钟',when:'每周日'};
const layout={version:1,title:goal.title,summary:'每周运动至少120分钟。',modules:[],tasks:[task,other],questions:[]};
function boundary(days) {
  const date=new Date();
  date.setHours(0,0,0,0);
  date.setDate(date.getDate()+days);
  return date.toISOString();
}
const snapshot={contextReviewAllowed:true,selectedTypes:['workout'],workoutMinutes:51,capturedAt:new Date().toISOString(),
  recentHistory:{workout:{recent:{startAt:boundary(-7),endAt:boundary(0),daysWithData:2,value:86,count:3},
    previous:{startAt:boundary(-14),endAt:boundary(-7),daysWithData:3,value:104,count:3}}}};
let number=0;
async function open({plan=layout,source='healthkit',active='health',initial=snapshot,planning={},connect=false}={}) {
  const dom=installDomStub({storage:{
    [KEY]:JSON.stringify({version:1,source,snapshot:initial,goals:[{id:'week',type:'workout',target:12}]}),
    [GOALS_KEY]:JSON.stringify({health:goal,[active]:goal}),
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:plan,[active]:plan}),[ACTIVE_GOAL_KEY]:active,
    [PLANNING_STATE_KEY]:JSON.stringify(planning),
    'along.health-sharing.v1':JSON.stringify({localGoalTitle:true,localPlanText:true,tasks:plan.tasks.map((t,i)=>({id:t.id,alias:'private-'+i,localText:true}))}),
    ...(connect?{[AGENT_KEY]:JSON.stringify({baseURL:'https://192.168.1.2:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)})}:{}),
  }});
  const calls=[];
  if (connect) window.AlongAgentBridge={request({path,body}) {
    if(path==='/connection/status') return Promise.resolve({along:true,runtime:DSH_RUNTIME,ready:true});
    if (path==='/super-agent/goals') return new Promise(resolve=>calls.push({body,resolve}));
    throw Error('unexpected '+path);
  }};
  await import('../web/app.mjs?local-progress='+ ++number);
  return {...dom,calls,observe:detail=>dom.fireWindow('along-health-update',{detail})};
}
const card=(dom,id)=>dom.app.innerHTML.match(new RegExp('data-task-id="'+id+'"[^>]*>([\\s\\S]*?)</button>'))?.[1]||'';

test('the original weekly task shows local Health progress and complete-day comparisons without changing the accepted plan or agent request',async()=>{
  const dom=await open({connect:true});
  const html=card(dom,task.id);
  assert.match(html,/本周运动 51 \/ 120 分钟[^<]*还差 69 分钟/);
  assert.match(html,/最近完整 7 天[^<]*86 分钟[^<]*2 天有记录/);
  assert.match(html,/此前 7 天[^<]*104 分钟[^<]*3 天有记录/);
  assert.match(html,/少 18 分钟/);
  assert.doesNotMatch(card(dom,other.id),/data-weekly-workout-progress/);
  const update=dom.observe({...snapshot,workoutMinutes:124});
  assert.match(card(dom,task.id),/本周运动 124 \/ 120 分钟[^<]*本周已达目标/);
  assert.deepEqual(JSON.parse(dom.storage.get(ADAPTIVE_LAYOUTS_KEY)).health.tasks,layout.tasks);
  assert.equal(dom.calls.length,1);
  const {body,resolve}=dom.calls[0];
  assert.equal(body.snapshot.workoutMinutes,124);
  assert.equal(body.snapshot.planning.weeklyWorkoutMinutes,null);
  assert.equal(body.goal.target,null);
  assert.deepEqual(body.snapshot.planning.protectedTaskIds,['private-0','private-1']);
  assert.doesNotMatch(JSON.stringify(body),/保留原任务私有内容|累计运动至少|原来的十二周健康目标|还差 69|本周已达目标/);
  resolve({run:{kind:'goal',status:'done',actual:true,runtime:body.runtime,requestId:body.requestId,source:{kind:'along'},trigger:{kind:'goal'},
    agents:[],events:[],assignments:[],result:{reply:'你的安排仍然适合目前记录。',layout:null,proposal:null,reassessment:{
      decision:'keep',basedOnRevision:body.requestId,reason:'Protected tasks; engine facts matched.',changes:[],watchFor:[],nextReviewAt:null}}}});
  await update;
  assert.match(dom.app.innerHTML,/你的安排仍然适合目前记录。/);
  assert.doesNotMatch(dom.app.innerHTML,/Protected tasks/);
});

test('weekly evidence disappears immediately on workout revocation, and never attaches to unrelated goals or ambiguous tasks',async()=>{
  const dom=await open();
  assert.match(card(dom,task.id),/data-weekly-workout-progress/);
  await dom.observe({...snapshot,selectedTypes:['steps'],steps:300});
  assert.doesNotMatch(dom.app.innerHTML,/data-weekly-workout-progress/);
  for(const options of [
    {source:'demo'}, {active:'custom:new-goal'}, {initial:{...snapshot,contextReviewAllowed:false}},
    {plan:{...layout,summary:'每周运动至少150分钟。',tasks:[task]}},
    {plan:{...layout,tasks:[other,{...task,id:'record',title:'每周回顾累计运动至少120分钟'}]}},
    {plan:{...layout,tasks:[task,{...task,id:'duplicate'}]}},
  ]) assert.doesNotMatch((await open(options)).app.innerHTML,/data-weekly-workout-progress/);
});

test('missing comparison coverage remains unknown and a recorded zero stays numeric',async()=>{
  const recent={...snapshot.recentHistory.workout.recent,value:null,count:null,daysWithData:0};
  const dom=await open({initial:{...snapshot,workoutMinutes:0,recentHistory:{workout:{...snapshot.recentHistory.workout,recent}}}});
  assert.match(card(dom,task.id),/本周运动 0 \/ 120 分钟[^<]*还差 120 分钟/);
  assert.match(card(dom,task.id),/最近完整 7 天[^<]*无运动记录/);
  assert.match(card(dom,task.id),/此前 7 天[^<]*104 分钟/);
  assert.doesNotMatch(card(dom,task.id),/少 104 分钟/);
});

test('an already validated previous-build keep prefers its user-facing reply and folds long explanations, while an unverified run cannot supply the text',async()=>{
  const decision={decision:'keep',reason:'Internal decision log: protected plan',at:new Date().toISOString(),runtime:DSH_RUNTIME,requestId:'completed'};
  const reply='保持当前安排。'.repeat(30)+'等下一次新的健康记录更新。';
  const planning={lastDecision:decision,recentDecisions:[decision],evaluated:snapshot,request:{requestId:'completed'},
    run:{actual:true,status:'done',runtime:DSH_RUNTIME,requestId:'completed',result:{reply,reassessment:{...decision,basedOnRevision:'completed'}}}};
  const dom=await open({planning});
  const summary=dom.app.innerHTML.match(/<strong>最近评估 · 保留当前安排<\/strong><details><summary>([^<]+)<\/summary><p>([^<]+)<\/p><\/details>/);
  assert.ok(summary,'only the preview is visible until the user expands it');
  assert.match(summary[1],/查看完整判断/);
  assert.ok(summary[1].length<reply.length);
  assert.equal(summary[2],reply);
  assert.doesNotMatch(dom.app.innerHTML,/Internal decision log/);
  for(const override of [{recentDecisions:[]},{evaluated:null},{run:{...planning.run,actual:false}},
    {request:{requestId:'different'}}]) {
    const fallback=await open({planning:{...planning,...override}});
    assert.match(fallback.app.innerHTML,/Internal decision log/);
    assert.doesNotMatch(fallback.app.innerHTML,/下一次新的健康记录/);
  }
});
