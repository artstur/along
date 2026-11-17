// Routing evidence contains opaque receipt identities only; private calculation inputs never enter notifications.
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const receipt=x=>typeof x==='string'&&/^calc_[a-f0-9]{40}$/.test(x);
const event=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(x);
export function resultEvidence(payload) {
  if(receipt(payload?.calculation_receipt_id))return {kind:'calculation',id:payload.calculation_receipt_id};
  const r=payload?.recommendation,n=payload?.notification;
  return r?.version===1&&Array.isArray(r.sources)&&r.sources.length>0&&event(n?.event_id)
    ?{kind:'research',id:n.event_id}:undefined;
}
export function validResultEvidence(e) {
  return record(e)&&Object.keys(e).every(k=>['kind','id'].includes(k))&&
    (e.kind==='calculation'?receipt(e.id):e.kind==='research'&&event(e.id));
}
export function taskResultRelevant(route,goal,task) {
  if(!goal||goal.id!==route.goalId||goal.status!=='active')return false;
  if(!route.taskId)return route.kind==='task_result'||(goal.currentRevision??goal.revision)===route.revision;
  if(!task||task.id!==route.taskId||task.goalId!==route.goalId||task.status==='cancelled'||
    (task.currentRevision??task.revision)!==route.revision)return false;
  if(task.status==='open')return true;
  if(task.status!=='done'||!validResultEvidence(route.evidence))return false;
  const execution=task.execution,e=route.evidence;
  return execution?.version===1&&Number.isSafeInteger(execution.count)&&execution.count>0&&Array.isArray(execution.records)&&
    execution.records.some(r=>e.kind==='calculation'
      ?r.kind==='calculation'&&r.outcome==='calculated'&&r.calculationReceiptId===e.id
      :r.kind==='research'&&r.outcome==='researched'&&r.recommendationEventId===e.id);
}
