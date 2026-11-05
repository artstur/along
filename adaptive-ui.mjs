export const ADAPTIVE_LAYOUTS_KEY = 'along.adaptive-layouts.v1';

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
  if (optional && value == null) return '';
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
  const target = typeof module.target === 'number' && Number.isFinite(module.target)
    ? module.target
    : text(module.target, '指标目标', 60);
  return {...base, source, target, unit:text(module.unit, '指标单位', 20, {optional:true}), note:text(module.note, '指标说明', 180, {optional:true})};
}

function cleanTask(value) {
  const task=object(value, '动态任务');
  const state=text(task.state, '任务状态', 20);
  if (!TASK_STATES.has(state)) throw Error('任务状态不受支持');
  return {
    id:id(task.id, '任务 ID'), when:text(task.when, '任务时间', 80), title:text(task.title, '任务标题', 100),
    detail:text(task.detail, '任务说明', 300), state,
  };
}

export function validateAdaptiveLayout(value, domain='health') {
  if (!['health','finance','custom'].includes(domain)) throw Error('目标类型无效');
  const layout=object(value, '个性化页面');
  if (layout.version !== 1) throw Error('个性化页面版本不受支持');
  const modules=list(layout.modules, '页面模块', 6).map(item=>cleanModule(item,domain));
  const tasks=list(layout.tasks, '动态任务', 6).map(cleanTask);
  const questions=list(layout.questions, '待确认问题', 6).map(item=>text(item, '待确认问题', 240));
  const ids=[...modules.map(item=>item.id),...tasks.map(item=>item.id)];
  if (new Set(ids).size !== ids.length) throw Error('页面模块 ID 重复');
  return {
    version:1,
    title:text(layout.title, '页面标题', 80),
    badge:text(layout.badge, '页面状态', 40, {optional:true}),
    summary:text(layout.summary, '页面摘要', 600),
    modules,
    tasks,
    questions,
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
