export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'along-personal-agent-v1';
const clone = value => structuredClone(value);
export const uid = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

export function createState() {
  return {
    version: SCHEMA_VERSION, view: 'goals', stage: 0, cycle: 1, taskFilter: 'todo',
    profile: { name: '林悦' },
    finance: { target: 24000, saved: 9600, months: 6, plannedMonthly: 2400, expense: 1800, deadline: '2027-04-30', plan: null },
    health: { sessions: 10, total: 24, weekly: 2, deadline: '2027-01-10' },
    connections: [
      { id: 'calendar', name: '日历', subtitle: '行程与可用时间', icon: 'calendar', connected: true, color: 'orange', scope: '仅读取示例行程', signal: '11 月 2—6 日 · 上海出差' },
      { id: 'health', name: 'Apple 健康', subtitle: '练习与睡眠记录', icon: 'heart', connected: true, color: 'rose', scope: '仅读取示例记录', signal: '上周完成 2 次瑜伽练习' },
      { id: 'bills', name: '账单', subtitle: '现金流与固定支出', icon: 'wallet', connected: true, color: 'purple', scope: '仅读取示例账单', signal: '本月新增计划外支出 ¥1,800' }
    ],
    memories: [
      { id: 'm-yoga', text: '平时更喜欢线下瑜伽，周末上午比较方便。', kind: 'confirmed', source: '用户在建立目标时说明', scope: '健康目标', expires: null, active: true, key: 'yoga-preference' },
      { id: 'm-budget', text: '进修预算 ¥24,000；原计划每月存入 ¥2,400。', kind: 'confirmed', source: '用户确认的目标', scope: '进修储蓄目标', expires: null, active: true, key: 'budget' },
      { id: 'm-maybe', text: '出差时，短时间的居家练习也许更容易坚持。', kind: 'hypothesis', source: '示例系统假设 · 尚未验证', scope: '出差情境', expires: null, active: false, key: 'travel-home' }
    ],
    knowledge: [
      { id: 'k-course', title: '瑜伽工作室 · 课程与请假说明', type: '资料', scope: '健康目标', source: '内置示例资料', content: '周六 10:00 有线下课程。出差期间可提前请假；请假不会要求补齐缺席次数。月度预算 ¥600。此内容为 Demo 示例，不对应真实机构。', created: '2026-10-20' },
      { id: 'k-study', title: '进修计划 · 费用与时间', type: '资料', scope: '进修储蓄目标', source: '内置示例资料', content: '目标预算 ¥24,000，当前已存 ¥9,600。原计划 2027 年 4 月底完成储蓄。计划允许申请下一期，是否延期需要本人确认。', created: '2026-10-20' }
    ],
    tasks: [
      { id: 't-yoga-1', title: '周二 · 线下瑜伽', note: '11 月 3 日 19:30 · 45 分钟', goal: 'health', status: 'todo', tag: '待开始', contribution: 1, generated: false },
      { id: 't-yoga-2', title: '周六 · 线下瑜伽', note: '11 月 7 日 10:00 · 45 分钟', goal: 'health', status: 'todo', tag: '待开始', contribution: 1, generated: false },
      { id: 't-save', title: '预留本月进修储蓄', note: '计划预留 ¥2,400 · 仅记录，不转账', goal: 'finance', status: 'todo', tag: '待开始', contribution: 2400, generated: false },
      { id: 't-review', title: '完成上周练习回顾', note: '上周两次练习都按计划完成', goal: 'health', status: 'done', tag: '已完成', contribution: 0, generated: false }
    ],
    events: [], logs: [], feedback: [], proposal: null, skillPending: false
  };
}

export function loadState(raw) {
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (s?.version !== SCHEMA_VERSION || !Array.isArray(s.memories) || !Array.isArray(s.tasks) || !Array.isArray(s.connections) || !Array.isArray(s.knowledge) || !Array.isArray(s.logs) || !Array.isArray(s.events) || !Array.isArray(s.feedback) || !s.finance || !s.health || !s.profile) return createState();
    const text=value=>typeof value==='string'&&value.length<=50000;
    const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
    if (!text(s.profile.name)||!['todo','done'].includes(s.taskFilter)||!Number.isInteger(s.cycle)||s.cycle<1) return createState();
    if (!s.tasks.every(t=>safeId(t.id)&&text(t.title)&&text(t.note)&&['todo','done'].includes(t.status)&&['health','finance'].includes(t.goal)&&Number.isFinite(t.contribution)&&t.contribution>=0)) return createState();
    if (!s.memories.every(m=>safeId(m.id)&&text(m.text)&&text(m.source)&&text(m.scope)&&typeof m.active==='boolean'&&['confirmed','hypothesis','rejected'].includes(m.kind))) return createState();
    if (!s.knowledge.every(k=>safeId(k.id)&&text(k.title)&&text(k.content)&&text(k.type)&&text(k.scope)&&text(k.source))) return createState();
    if (!s.connections.every(c=>['calendar','health','bills'].includes(c.id)&&typeof c.connected==='boolean')) return createState();
    if (![s.finance.target, s.finance.saved, s.health.sessions].every(Number.isFinite) || ![0,1,2].includes(s.stage)) return createState();
    if (!['goals','connections','memory','knowledge','tasks'].includes(s.view)) s.view='goals';
    return s;
  } catch { return createState(); }
}

export function activeMemory(s, key) {
  return s.memories.find(m => m.key === key && m.active && m.kind === 'confirmed' && (key!=='travel-restart'||m.scope==='健康目标 · 出差中断后') && (!m.expires || m.expires >= (s.cycle === 1 ? '2026-11-02' : '2026-11-16')));
}

export function triggerChange(state) {
  if (state.stage === 1) return state;
  const s = clone(state);
  if (s.stage === 2) { s.cycle += 1; s.stage = 1; }
  else s.stage = 1;
  const travel = s.connections.some(c => c.id === 'calendar' && c.connected);
  const bills = s.connections.some(c => c.id === 'bills' && c.connected);
  s.events = [];
  if (travel) s.events.push({ id: `e-travel-${s.cycle}`, type: 'travel', source: '日历 · 模拟数据', text: s.cycle === 1 ? '11 月 2—6 日，上海出差' : '11 月 16—18 日，新增短途出差' });
  if (bills && s.cycle === 1) s.events.push({ id:'e-expense-1', type:'expense', source:'账单 · 模拟数据', text:'本月新增计划外支出 ¥1,800' });
  s.proposal = null;
  return s;
}

export function suggest(state) {
  const travel = state.events.some(e=>e.type==='travel');
  const expense = state.events.some(e=>e.type==='expense');
  const learned = travel && Boolean(activeMemory(state,'travel-restart'));
  return {
    travel, expense, learned,
    practice: learned ? 'pause' : 'home',
    finance: expense ? 'extend' : 'keep',
    reasons: [
      ...(travel ? [{ type:'fact', text:state.events.find(e=>e.type==='travel').text, source:'日历 · 当前模拟事件' }] : []),
      ...(expense ? [{ type:'fact', text:`本月可储蓄金额从 ¥${state.finance.plannedMonthly.toLocaleString()} 降至 ¥${Math.max(0,state.finance.plannedMonthly-state.finance.expense).toLocaleString()}。`, source:`账单 · ¥${state.finance.plannedMonthly.toLocaleString()} − ¥${state.finance.expense.toLocaleString()}` }] : []),
      ...(travel ? [{ type:learned?'memory':'hypothesis', text: learned ? '沿用你确认过的方式：出差不补练，回来先恢复一次线下课。' : '出差时改为居家短练习是否更合适，仍需要你确认。', source:learned?'记忆 · 出差后的恢复方式':'待验证假设 · 尚未用于修改计划' }] : [])
    ]
  };
}

export function financePreview(state, choice) {
  const f=state.finance;
  if (!state.events.some(e=>e.type==='expense')) return { now: f.plan?.now ?? f.plannedMonthly, later:f.plan?.later ?? f.plannedMonthly, laterMonths:f.plan?.laterMonths ?? f.months-1, months:f.months, deadline:f.deadline, gap:0 };
  const gap=f.expense;
  const now=Math.max(0,f.plannedMonthly-gap);
  const remaining=Math.max(0,f.target-f.saved-now);
  const laterMonths=choice==='extend'?f.months:f.months-1;
  let deadline=f.deadline;
  if(choice==='extend'){
    const old=new Date(f.deadline+'T00:00:00Z');
    deadline=new Date(Date.UTC(old.getUTCFullYear(),old.getUTCMonth()+2,0)).toISOString().slice(0,10);
  }
  return { now, later:laterMonths>0?Math.ceil(remaining/laterMonths):0, laterMonths, months:laterMonths+1, deadline, gap, feasible:laterMonths>0||remaining===0 };
}

function addLog(s, text, detail) { s.logs.unshift({id:uid('log'),text,detail,cycle:s.cycle}); }

export function applyProposal(state, input) {
  if (state.stage !== 1) throw new Error('请先模拟一次变化。');
  if (!['extend','catchup','keep'].includes(input.finance) || !['pause','home'].includes(input.practice)) throw new Error('请选择有效的调整方式。');
  const s=clone(state), p=suggest(s);
  if (!p.travel && !p.expense) throw new Error('当前没有可用变化，请先连接模拟日历或账单。');
  if(p.expense && !['extend','catchup'].includes(input.finance)) throw new Error('请选择如何处理预算缺口。');
  const preview=financePreview(s,input.finance);
  if(preview.feasible===false)throw new Error('当前期限没有后续月份可补足，请选择延后期限。');
  s.proposal={...input,preview,cycle:s.cycle,applied:true};
  s.stage=2;
  if(p.expense){
    s.finance.plan={...preview}; s.finance.months=preview.months; s.finance.deadline=preview.deadline;
    const savingTask=s.tasks.find(t=>t.id==='t-save');
    if(savingTask?.status==='done') { s.finance.saved-=savingTask.contribution; savingTask.status='todo'; }
    if(savingTask){savingTask.contribution=preview.now;savingTask.note=`本月预留 ¥${preview.now.toLocaleString()} · 仅记录，不转账`;savingTask.tag='已调整';}
    const memory=s.memories.find(m=>m.key==='budget');
    if(memory) memory.text=`进修预算 ¥${s.finance.target.toLocaleString()}；本月预留 ¥${preview.now}，后续 ${preview.laterMonths} 个月每月 ¥${preview.later.toLocaleString()}；期限 ${preview.deadline}。`;
  }
  if(p.travel){
    s.tasks=s.tasks.filter(t=>!(t.goal==='health'&&t.status==='todo'&&(['t-yoga-1','t-yoga-2'].includes(t.id)||t.id.startsWith('t-travel-'))));
    if(input.practice==='pause'){
      s.tasks.push({id:`t-travel-${s.cycle}`,title:'出差回来，先恢复一次线下课',note:s.cycle===1?'11 月 7 日 10:00 · 不补排缺席练习':'11 月 21 日 10:00 · 先恢复节奏',goal:'health',status:'todo',tag:'已调整',contribution:1,generated:true});
    }else{
      s.tasks.push({id:`t-travel-${s.cycle}`,title:'出差期间，尝试一次居家短练习',note:'自选 15 分钟 · 完成后再反馈是否适合',goal:'health',status:'todo',tag:'试一试',contribution:1,generated:true});
    }
    if(input.remember && input.practice==='pause'){
      const previous=s.memories.find(m=>m.key==='travel-restart');
      const m={id:previous?.id??uid('m'),key:'travel-restart',text:'因出差中断时，不补排缺席练习；回来先恢复一次线下课。',kind:'confirmed',source:'你在调整方案时明确确认',scope:'健康目标 · 出差中断后',expires:null,active:true};
      if(previous)Object.assign(previous,m);else s.memories.push(m);
    }
    const hypothesis=s.memories.find(m=>m.key==='travel-home');
    if(hypothesis&&input.practice==='pause'){hypothesis.active=false;hypothesis.text='“出差时更适合居家练习”的假设已被本次选择纠正。';hypothesis.kind='rejected';}
  }
  if(input.note?.trim()){
    s.feedback.push({id:uid('f'),text:input.note.trim().slice(0,1000),source:'本次用户补充',cycle:s.cycle});
  }
  addLog(s,`第 ${s.cycle} 次安排已由你确认`, `${p.travel?(input.practice==='pause'?'出差不补练，回来恢复线下课':'本次尝试居家短练习'):'练习安排未改变'}${p.expense?`；${input.finance==='extend'?'进修延后一个月':'保留进修日期，后续分月补足'}。`:'。'}${input.note?.trim()?` 补充：${input.note.trim().slice(0,120)}`:''}`);
  return s;
}

export function toggleTask(state,id,feedback=''){
  const s=clone(state),t=s.tasks.find(t=>t.id===id);
  if(!t)return s;
  const sign=t.status==='done'?-1:1;
  t.status=t.status==='done'?'todo':'done';
  t.tag=t.status==='done'?'已完成':'待开始';
  if(t.goal==='health')s.health.sessions=Math.max(0,s.health.sessions+sign*t.contribution);
  if(t.goal==='finance')s.finance.saved=Math.max(0,s.finance.saved+sign*t.contribution);
  if(feedback.trim())s.feedback.push({id:uid('f'),taskId:id,text:feedback.trim(),cycle:s.cycle});
  s.skillPending=t.generated&&t.status==='done'&&Boolean(activeMemory(s,'travel-restart'))&&!s.knowledge.some(k=>k.skillKey==='travel-restart');
  return s;
}

export function saveSkill(state){
  const s=clone(state);
  if(!s.skillPending||s.knowledge.some(k=>k.skillKey==='travel-restart'))return s;
  s.knowledge.push({id:uid('k'),skillKey:'travel-restart',title:'出差后，温和恢复练习',type:'合作方法',scope:'健康目标 · 出差后',source:'用户确认的方法 · 一次执行记录',created:'2026-11-07',content:'适用：因出差中断练习，且用户仍希望继续健康目标。\n方法：核实返程后的时间；不补排缺席练习；先安排一次熟悉的线下课；结束后询问是否适合。\n证据：用户明确选择，并有一次任务完成记录；不足以证明长期有效。\n暂停条件：用户改变偏好、课程不可用、身体反馈变化。涉及不适时先核实，不能自动推断身体恢复。'});
  s.skillPending=false;
  return s;
}

export function editMemory(state,id,patch){
  const s=clone(state),m=s.memories.find(m=>m.id===id);if(!m)return s;
  if(typeof patch.text==='string'){
    const next=patch.text.trim().slice(0,1000);
    if(next!==m.text&&m.key==='travel-restart')m.key='custom';
    m.text=next;
  }
  if(typeof patch.active==='boolean')m.active=patch.active;
  if(typeof patch.scope==='string')m.scope=patch.scope.trim().slice(0,120);
  m.source='用户手动修改';return s;
}
