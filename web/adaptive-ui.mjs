import {numberLikeTarget} from './goal-agent-core.mjs';

export const ADAPTIVE_LAYOUTS_KEY = 'along.adaptive-layouts.v1';

// 只有字符串和数字算文本；对象、数组、布尔都不是。
function layoutText(value) {
  if (typeof value==='string') return value;
  if (typeof value==='number'&&Number.isFinite(value)) return String(value);
  return value;
}
// 截断真的文本；类型不对的值原样留着，交给共享校验层拒收。
function trim(raw,max,fallback) {
  if (raw==null) return fallback;
  const text=layoutText(raw);
  if (typeof text!=='string') return text;
  return text.trim().slice(0,max)||fallback;
}

export function isCustomGoalKey(value) {
  return value === 'custom' || (typeof value === 'string' && value.startsWith('custom:'));
}

export function goalDomain(value) {
  return isCustomGoalKey(value) ? 'custom' : value;
}

export function customGoalEntries(goals={}, layouts={}) {
  const keys=new Set([...Object.keys(goals),...Object.keys(layouts)]);
  return [...keys]
    .filter(isCustomGoalKey)
    .map(key=>({key,title:goals[key]?.title || layouts[key]?.title || ''}))
    .filter(item=>item.title);
}

const MODULE_KINDS = new Set(['summary', 'fact_list', 'chips', 'metric']);
const TASK_STATES = new Set(['temporary', 'planned', 'deferred']);
const METRIC_SOURCES = {
  health: new Set(['workoutMinutes', 'sleepMinutes', 'weightKg']),
  finance: new Set(['saved']),
  custom: new Set(),
};

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label}格式不正确`);
  return value;
}

function text(value, label, max, {optional = false} = {}) {
  // 可选字段「缺失」与「为空」是同一件事：不该因为一个空标签把整份内容作废。
  if (optional&&(value==null||(typeof value==='string'&&!value.trim()))) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw Error(`${label}格式不正确`);
  return value.trim();
}

function list(value, label, max) {
  if (!Array.isArray(value) || value.length > max) throw Error(`${label}格式不正确`);
  return value;
}

function id(value, label) {
  const clean = text(value, label, 64);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(clean)) throw Error(`${label}格式不正确`);
  return clean;
}

// 指标目标写成数字字符串时（"120"、"10,000"）它就是那个数字：不能绕过范围
// 校验，也不能因为类型不是 number 就丢掉进度条。不是数字的说明文字只用来显示。
// 数字规则来自共享契约层（和目标提案用的是同一份），不能各写一套。
function metricTargetValue(raw,limit) {
  const parsed=numberLikeTarget(raw);
  if (typeof parsed==='number') {
    if (!Number.isFinite(parsed)||parsed<=0||parsed>limit) throw Error('指标目标格式不正确');
    return parsed;
  }
  return text(raw, '指标目标', 60);
}

function cleanModule(value, domain) {
  const module = object(value, '页面模块');
  const kind = text(module.kind, '模块类型', 20);
  if (!MODULE_KINDS.has(kind)) throw Error('页面包含未允许的模块类型');
  const base = {kind, id:id(module.id, '模块 ID'), title:text(module.title, '模块标题', 60)};
  if (kind === 'summary') return {...base, content:text(module.content, '摘要内容', 500)};
  if (kind === 'fact_list') {
    return {...base, items:list(module.items, '事实列表', 6).map(item => {
      const pair=object(item, '事实项');
      return {label:text(pair.label, '事实标签', 40), value:text(pair.value, '事实内容', 180)};
    })};
  }
  if (kind === 'chips') return {...base, items:list(module.items, '标签列表', 8).map(item=>text(item, '标签', 32))};
  const source=text(module.source, '指标来源', 30);
  if (!METRIC_SOURCES[domain]?.has(source)) throw Error('指标来源不受信任');
  const limit=domain==='finance'?10000000:10080;
  const target=metricTargetValue(module.target,limit);
  return {...base, source, target, unit:text(module.unit, '指标单位', 20, {optional:true}), note:text(module.note, '指标说明', 180, {optional:true})};
}

function cleanTask(value) {
  const task=object(value, '动态任务');
  const state=text(task.state, '任务状态', 20);
  if (!TASK_STATES.has(state)) throw Error('任务状态不受支持');
  if (task.kind!=null&&!['agent_action','reminder','recommendation'].includes(task.kind)) throw Error('未知的任务类型');
  if (task.kind==='reminder' && (typeof task.scheduledFor!=='string'||!/(Z|[+-]\d\d:\d\d)$/i.test(task.scheduledFor)||!Number.isFinite(Date.parse(task.scheduledFor)))) throw Error('提醒需要带时区的日期和时间');
  return {
    id:id(task.id, '任务 ID'), when:text(task.when, '任务时间', 80), title:text(task.title, '任务标题', 100),
    detail:text(task.detail, '任务说明', 300), state,...(task.kind?{kind:task.kind}:{}),
    ...(task.kind==='reminder'?{scheduledFor:new Date(task.scheduledFor).toISOString()}:{}),
  };
}

function cleanConnection(value) {
  const connection=object(value, '推荐连接');
  return {
    id:id(connection.id, '连接 ID'),
    name:text(connection.name, '连接名称', 60),
    reason:text(connection.reason, '推荐原因', 240),
    capability:text(connection.capability, '连接能力', 160),
    status:'recommended',
  };
}

function inferredConnections(layout, domain, connections) {
  if (connections.length || domain!=='custom') return connections;
  const context=[layout.title,layout.summary,...layout.tasks.map(task=>`${task.title} ${task.detail}`)].join(' ');
  if (!/(日语|N5|五十音|假名|Japanese)/i.test(context)) return connections;
  return [{id:'duolingo',name:'Duolingo',reason:'把每日练习放进现有学习习惯，降低启动成本。',capability:'打开日语课程；账户进度需经 Duolingo 授权后才能同步。',status:'recommended'}];
}

// 待确认问题：两条运行时必须给出同一个判断。Kimi 运行时先把模型给的列表归一，
// DSH 运行时不归一——同一份模型输出会让一边作废整份目标空间、一边照单全收。
// 这里把两边的口径统一：不是列表就当没有，最多取 6 条，每条截到 240 字。
export function normalizeQuestions(value) {
  const questions=Array.isArray(value)?value:[];
  // 只有字符串和数字算文本：对象、数组、布尔都不算，不能兜底成 "[object Object]"
  // 落到用户的首页上。算不出文本的那一条直接丢掉——待确认问题是可选列表，
  // 不该因为其中一条是脏数据就把整份目标空间作废。
  return questions.slice(0,6)
    .map(question=>layoutText(question))
    .filter(question=>typeof question==='string')
    .map(question=>question.trim().slice(0,240)||'待确认问题');
}

// 模型给的布局常常有点毛刺：标题太长、模块 id 重复、给了第 7 个模块、
// 混进了没被允许的模块类型。两条运行时必须对同一份输出给出同一个结论，
// 所以归一放在共享层，两条运行时都用它。
// 能修的修掉（截断、编号、去重、丢掉超量与未知类型）；修不了的（文本类型
// 不对）原样留给共享校验层拒绝——不兜底成 "[object Object]"，那种脏文本会
// 直接出现在用户的首页上。
// 推荐连接也是可选列表：一条脏连接不该把整份目标空间带崩（回复和任务都还在）。
// 修得了的修好（编号、截断），修不了的（文本类型不对）丢掉这一条。
function normalizeConnections(value,nextId) {
  return (Array.isArray(value)?value:[]).slice(0,4)
    .filter(item=>item&&typeof item==='object')
    .map((item,index)=>({
      id:nextId(item.id,'connection',index),
      name:trim(item.name,60,`连接 ${index+1}`),
      reason:trim(item.reason,240,'待补充'),
      capability:trim(item.capability,160,'待补充'),
      status:'recommended',
    }))
    .filter(item=>typeof item.name==='string'&&typeof item.reason==='string'&&typeof item.capability==='string');
}

export function normalizeAdaptiveLayout(value, domain='health') {
  if (!value||typeof value!=='object') return value;
  const used=new Set();
  const nextId=(raw,prefix,index)=>{
    const base=String(raw||`${prefix}-${index+1}`).toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,52)||`${prefix}-${index+1}`;
    let id=base,n=2;while(used.has(id)) id=`${base.slice(0,48)}-${n++}`;used.add(id);return id;
  };
  const modules=(Array.isArray(value.modules)?value.modules:[]).filter(module=>module&&['summary','fact_list','chips','metric'].includes(module.kind)&&!(domain==='custom'&&module.kind==='metric')).slice(0,6).map((module,index)=>{
    const base={kind:module.kind,id:nextId(module.id,'module',index),title:trim(module.title,60,`模块 ${index+1}`)};
    if (module.kind==='summary') return {...base,content:trim(module.content||module.note,500,'待补充')};
    if (module.kind==='fact_list') {
      const facts=Array.isArray(module.items)?module.items:Array.isArray(module.facts)?module.facts:[];
      return {...base,items:facts.slice(0,6).map((fact,factIndex)=>fact&&typeof fact==='object'
        ? {label:trim(fact.label,40,`要点 ${factIndex+1}`),value:trim(fact.value,180,'待补充')}
        : {label:`要点 ${factIndex+1}`,value:trim(fact,180,'待补充')})};
    }
    if (module.kind==='chips') {
      const chips=Array.isArray(module.items)?module.items:Array.isArray(module.chips)?module.chips:[];
      return {...base,items:chips.slice(0,8).map(chip=>trim(chip,32,'要点'))};
    }
    return {...base,source:trim(module.source,30,''),target:module.target,unit:module.unit==null?null:trim(module.unit,20,''),note:module.note==null?null:trim(module.note,180,'')};
  });
  const tasks=(Array.isArray(value.tasks)?value.tasks:[]).slice(0,6).map((task,index)=>({
    id:nextId(task?.id,'task',index),when:trim(task?.when,80,'待安排'),title:trim(task?.title,100,`任务 ${index+1}`),detail:trim(task?.detail,300,'待补充'),
    state:['temporary','planned','deferred'].includes(task?.state)?task.state:'planned',
    kind:task?.kind,scheduledFor:task?.scheduledFor,
  }));
  return {
    version:1,
    title:trim(value.title,80,'我的目标'),
    badge:value.badge==null?null:trim(value.badge,40,''),
    summary:trim(value.summary,600,'目标计划已生成'),
    modules,tasks,
    questions:normalizeQuestions(value.questions),
    connections:normalizeConnections(value.connections,nextId),
  };
}

export function validateAdaptiveLayout(value, domain='health') {
  if (!['health','finance','custom'].includes(domain)) throw Error('目标类型无效');
  const layout=object(value, '个性化页面');
  if (layout.version !== 1) throw Error('个性化页面版本不受支持');
  const modules=list(layout.modules, '页面模块', 6).map(item=>cleanModule(item,domain));
  const tasks=list(layout.tasks, '动态任务', 6).map(cleanTask);
  // 待确认问题是可选列表：没给就当没有，不能因此把整份目标空间作废（和推荐连接一致）。
  const questions=list(layout.questions ?? [], '待确认问题', 6).map(item=>text(item, '待确认问题', 240));
  const connections=inferredConnections(layout,domain,list(layout.connections??[], '推荐连接', 4).map(cleanConnection));
  const ids=[...modules.map(item=>item.id),...tasks.map(item=>item.id),...connections.map(item=>item.id)];
  if (new Set(ids).size !== ids.length) throw Error('页面模块 ID 重复');
  return {
    version:1,
    title:text(layout.title, '页面标题', 80),
    badge:text(layout.badge, '页面状态', 40, {optional:true}),
    summary:text(layout.summary, '页面摘要', 600),
    modules,
    tasks,
    questions,
    connections,
  };
}

export function safeAdaptiveLayout(value, domain='health') {
  try { return validateAdaptiveLayout(value,domain); }
  catch { return null; }
}

export function findInitialCustomGoalCandidate(history, existingGoal=null, existingLayout=null) {
  if (existingGoal || existingLayout || !Array.isArray(history)) return null;
  for (let index=history.length-1; index>=0; index-=1) {
    const item=history[index];
    if (item?.role !== 'assistant' || item.proposal?.target !== null || !item.proposal?.title || !item.layout?.title) continue;
    if (!Array.isArray(item.layout.tasks) || item.layout.tasks.length === 0) continue;
    return {index,item};
  }
  return null;
}
