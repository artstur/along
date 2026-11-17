import test from 'node:test';import assert from 'node:assert/strict';
import {taskResultRelevant,resultEvidence} from '../web/task-results.mjs';
const calc='calc_'+'a'.repeat(40),other='calc_'+'b'.repeat(40);
const goal={status:'active',id:'g_result',revision:2};
const task={id:'t_result',goalId:goal.id,status:'done',revision:3,execution:{version:1,count:1,records:[{kind:'calculation',outcome:'calculated',calculationReceiptId:calc}]}};
const route={goalId:goal.id,taskId:task.id,revision:3,kind:'task_result',evidence:{kind:'calculation',id:calc}};
test('a completed calculation result must match this receipt, task and current revision',()=>{
 assert.equal(taskResultRelevant(route,goal,task),true);
 for(const [r,g,t] of [[{...route,evidence:undefined},goal,task],[{...route,evidence:{kind:'calculation',id:other}},goal,task],
  [{...route,revision:2},goal,task],[{...route,taskId:'other_task'},goal,task],[route,goal,{...task,status:'cancelled'}],
  [route,{...goal,status:'archived'},task],[route,{...goal,id:'foreign_goal'},task],[route,goal,{...task,goalId:'foreign'}],[route,goal,{...task,execution:undefined}]])assert.equal(taskResultRelevant(r,g,t),false);
 assert.equal(taskResultRelevant({...route,revision:2},goal,{...task,status:'open'}),false,'old results cannot cross a newer task revision');
});
test('completed research requires its actual recommendation event; open current legacy results remain compatible',()=>{
 const evidence={kind:'research',id:'followup_due_1'},r={...route,kind:'recommendation_ready',evidence};
 const t={...task,execution:{version:1,count:1,records:[{kind:'research',outcome:'researched',recommendationEventId:evidence.id}]}};
 assert.equal(taskResultRelevant(r,goal,t),true);assert.equal(taskResultRelevant({...r,evidence:{...evidence,id:'old_research'}},goal,t),false);
 assert.equal(taskResultRelevant({...r,evidence:undefined},goal,{...t,status:'open'}),true);
 assert.deepEqual(resultEvidence({calculation_receipt_id:calc}),route.evidence);
 assert.equal(resultEvidence({calculation_receipt_id:'not_a_receipt'}),undefined);
});
