import test from 'node:test';
import assert from 'node:assert/strict';
import {createState,loadState,triggerChange,suggest,financePreview,applyProposal,toggleTask,editMemory,saveSkill} from '../web/engine.mjs';
const choose=(s,patch={})=>applyProposal(s,{finance:'extend',practice:'pause',remember:true,note:'线下瑜伽对我很重要。',...patch});
test('initial assumptions never become confirmed memory on their own',()=>{
 const s=triggerChange(createState()),p=suggest(s);
 assert.equal(p.practice,'home');assert.equal(p.learned,false);
 assert.ok(p.reasons.some(r=>r.type==='hypothesis'));
 assert.equal(s.memories.find(m=>m.kind==='hypothesis').active,false);
});
test('both savings paths actually fund the goal and preserve the proper deadline',()=>{
 const s=triggerChange(createState());
 const extend=financePreview(s,'extend'),catchup=financePreview(s,'catchup');
 assert.equal(extend.later,2300);assert.equal(catchup.later,2760);
 assert.equal(s.finance.saved+extend.now+extend.later*extend.laterMonths,s.finance.target);
 assert.equal(s.finance.saved+catchup.now+catchup.later*catchup.laterMonths,s.finance.target);
 assert.equal(extend.deadline,'2027-05-31');assert.equal(catchup.deadline,'2027-04-30');
 assert.equal(s.finance.deadline,'2027-04-30');
});
test('user-confirmed adjustment updates targets, tasks and scoped memory together',()=>{
 const initial=createState(),s=choose(triggerChange(initial));
 assert.equal(initial.stage,0);assert.equal(s.stage,2);assert.equal(s.finance.deadline,'2027-05-31');
 assert.equal(s.tasks.find(t=>t.id==='t-save').contribution,600);
 assert.ok(s.tasks.some(t=>t.id==='t-travel-1'));
 assert.ok(!s.tasks.some(t=>t.id==='t-yoga-1'));
 assert.equal(s.memories.find(m=>m.key==='travel-restart').scope,'健康目标 · 出差中断后');
 assert.throws(()=>choose(s),/先模拟/);
});
test('two weeks later reuses only opted-in, active, applicable and unexpired memory',()=>{
 const confirmed=choose(triggerChange(createState()));
 assert.equal(suggest(triggerChange(confirmed)).practice,'pause');
 const id=confirmed.memories.find(m=>m.key==='travel-restart').id;
 assert.equal(suggest(triggerChange(editMemory(confirmed,id,{active:false}))).practice,'home');
 assert.equal(suggest(triggerChange(editMemory(confirmed,id,{scope:'进修储蓄目标'}))).practice,'home');
 assert.equal(suggest(triggerChange(editMemory(confirmed,id,{text:'出差时想试试居家练习'}))).practice,'home');
 const expired=structuredClone(confirmed);expired.memories.find(m=>m.id===id).expires='2026-11-08';
 assert.equal(suggest(triggerChange(expired)).practice,'home');
 const optOut=choose(triggerChange(createState()),{remember:false});
 assert.equal(suggest(triggerChange(optOut)).learned,false);
});
test('disconnected sources do not invent events or affect other goals',()=>{
 const s=createState();s.connections.find(c=>c.id==='bills').connected=false;
 const triggered=triggerChange(s);assert.equal(suggest(triggered).expense,false);
 const applied=choose(triggered,{finance:'keep'});assert.equal(applied.finance.deadline,s.finance.deadline);
 const none=createState();none.connections.forEach(c=>c.connected=false);
 assert.throws(()=>choose(triggerChange(none)),/没有可用变化/);
});
test('complete and undo are reversible without double-counting finances or sessions',()=>{
 const s=choose(triggerChange(createState()));
 const done=toggleTask(s,'t-save');assert.equal(done.finance.saved,10200);
 const undo=toggleTask(done,'t-save');assert.equal(undo.finance.saved,9600);
 const trained=toggleTask(s,'t-travel-1','这种方式容易恢复');assert.equal(trained.health.sessions,11);
 assert.equal(toggleTask(trained,'t-travel-1').health.sessions,10);
});
test('skills require an execution record and are not duplicated',()=>{
 const s=choose(triggerChange(createState()));assert.equal(saveSkill(s).knowledge.length,2);
 const done=toggleTask(s,'t-travel-1');const learned=saveSkill(done);
 assert.equal(learned.knowledge.length,3);assert.match(learned.knowledge[2].content,/不足以证明长期有效/);
 assert.equal(saveSkill(learned).knowledge.length,3);
});
test('user-created tasks survive plan changes',()=>{
 const s=createState();s.tasks.push({id:'custom',goal:'health',status:'todo',generated:false,title:'咨询课程安排',contribution:0});
 assert.ok(choose(triggerChange(s)).tasks.some(t=>t.id==='custom'));
});
test('custom deadlines remain dynamic and short horizons reject impossible catch-up',()=>{
 const s=createState();s.finance.deadline='2027-06-30';s.finance.months=8;
 assert.equal(financePreview(triggerChange(s),'extend').deadline,'2027-07-31');
 s.finance.months=1;assert.throws(()=>choose(triggerChange(s),{finance:'catchup'}),/后续月份/);
});
test('broken persistence safely resets instead of crashing',()=>{
 assert.deepEqual(loadState('{broken'),createState());
 assert.deepEqual(loadState('{"version":99}'),createState());
 const s=choose(triggerChange(createState()));assert.deepEqual(loadState(JSON.stringify(s)),s);
});
