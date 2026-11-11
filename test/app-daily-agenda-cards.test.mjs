import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {KEY} from '../web/health.mjs';
import {AGENT_KEY,GOALS_KEY} from '../web/agent-client.mjs';
import {ADAPTIVE_LAYOUTS_KEY} from '../web/adaptive-ui.mjs';
import {DSH_RUNTIME,AGENT_RUNTIME_KEY} from '../web/super-agent.mjs';
import {PLANNING_STATE_KEY} from '../web/contextual-planning.mjs';
const when=m=>new Date(Date.now()+m*60000).toISOString(),tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
const localDay=d=>new Intl.DateTimeFormat('en-CA',{timeZone:tz}).format(d);
async function open({day=localDay(new Date()),status='scheduled',workoutMinutes=18,extra=false,topicAllowed=true,device=true}={}) {
  const grant={goalKey:'health',id:'my-grant',topics:['sleep','workout'],weeklyWorkoutMinutes:180};
  const layout={version:1,title:'我的十二周',summary:'每周运动至少180分钟。',modules:[],questions:[],tasks:[
    {id:'weekly',title:'累计运动至少180分钟',when:'每周',detail:'老的运动说明',state:'planned'},
    {id:'sleep',title:'安排充足睡眠时间',when:'每晚',detail:'老的睡眠说明',state:'planned'},
    ...(extra?[{id:'other',title:'提前睡觉',when:'每周',detail:'另一个独立任务',state:'planned'}]:[])
  ]};
  const config={baseURL:'https://192.0.2.1:4176',fingerprint:'A'.repeat(64),token:'a'.repeat(64)};
  const snapshot={contextReviewAllowed:true,selectedTypes:topicAllowed?['sleep','workout']:['workout'],capturedAt:new Date().toISOString(),workoutMinutes:73};
  const action={sleepReminderAt:when(26),bedtimeAt:when(56),workoutMinutes,workoutReminderAt:workoutMinutes===0?null:when(8),
    reason:'根据已选记录限制今天的运动量。',localDate:day,timezone:tz,evaluatedAt:when(-2),delegationId:grant.id,runtime:DSH_RUNTIME,requestId:'confirmed-run',ticketId:'confirmed-ticket'};
  const dom=installDomStub({storage:{[KEY]:JSON.stringify({version:1,source:'healthkit',snapshot,goals:[]}),
    [GOALS_KEY]:JSON.stringify({health:{title:layout.title}}),[AGENT_KEY]:JSON.stringify(config),[AGENT_RUNTIME_KEY]:DSH_RUNTIME,
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:layout}),'along.health-sharing.v1':JSON.stringify({dailyDelegation:grant,dailyRecipient:config.fingerprint}),
    [PLANNING_STATE_KEY]:JSON.stringify({dailyRecord:{action,evidence:snapshot}})}});
  window.AlongAgentBridge={request:async()=>({along:true,ready:true,runtime:DSH_RUNTIME}),...(device?{dailyReminderStatus:async({goalKey,localDate,timezone})=>({goalKey,localDate,timezone,items:{
    sleep:{status,scheduledFor:action.sleepReminderAt,requestId:action.requestId},workout:{status,scheduledFor:action.workoutReminderAt,requestId:action.requestId}}}),
    notification:async()=>({})}:{})};
  await import('../web/app.mjs?dailycards='+ ++instance);
  await new Promise(r=>setImmediate(r));
  return {dom,layout,html:dom.app.innerHTML};
}
let instance=0;
const card=(html,id)=>html.match(new RegExp('data-task-id="'+id+'"[^>]*>([\\s\\S]*?)</button>'))?.[1]||'';
test('daily actions replace the two generic task headlines in place and distinguish OS vs DSH evidence',async()=>{
  const {dom,html,layout}=await open();
  const workout=card(html,'weekly'),sleep=card(html,'sleep');
  assert.match(workout,/今天建议运动 18 分钟/);assert.match(workout,/DSH 已规划/);assert.match(workout,/运动提醒/);assert.match(workout,/iPhone 已安排/);
  assert.match(sleep,/提醒准备睡觉/);assert.match(sleep,/建议就寝/);
  assert.doesNotMatch(html,/class="next-reminder"|老的睡眠说明/);
  assert.deepEqual(JSON.parse(dom.storage.get(ADAPTIVE_LAYOUTS_KEY)).health.tasks,layout.tasks);
  const pending=await open({device:false});assert.match(card(pending.html,'weekly'),/手机排程待确认/);assert.doesNotMatch(pending.html,/iPhone 已安排/);
});
test('yesterday or lost consent cannot leak into today; rest is zero without a fake notification; ambiguous sleep slots stay separate',async()=>{
  for(const opt of [{day:localDay(new Date(Date.now()-86400000))},{topicAllowed:false}]) assert.doesNotMatch((await open(opt)).html,/今天建议运动 18 分钟|DSH 已规划/);
  const rest=card((await open({workoutMinutes:0})).html,'weekly');assert.match(rest,/今天休息/);assert.doesNotMatch(rest,/运动提醒|iPhone 已安排/);
  const ambiguous=(await open({extra:true})).html;assert.match(ambiguous,/class="generated-task day-task" data-daily-topic="sleep"/);assert.doesNotMatch(card(ambiguous,'sleep'),/提醒准备睡觉/);
});
