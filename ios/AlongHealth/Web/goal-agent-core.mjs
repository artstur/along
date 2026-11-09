// 显著变化的分钟门槛：真实变化路由与「目标变化实验」演示必须用同一个值。
export const SIGNIFICANT_MINUTES=15;

export function routeHealthChange(before, after, target) {
  const a = before?.workoutMinutes;
  const b = after?.workoutMinutes;
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isInteger(target) || target < 1) return {decision: 'quiet', reason: '尚无可比较的健身记录'};
  const oldRemaining = Math.max(0, target - a);
  const remaining = Math.max(0, target - b);
  const delta = b - a;
  if (delta <= 0) return {decision: 'quiet', reason: '健身时长没有增加'};
  if (oldRemaining === 0 || (delta < SIGNIFICANT_MINUTES && remaining > 0)) return {decision: 'quiet', reason: '变化较小，保留当前任务'};
  return {decision: 'replan', reason: `本周新增 ${delta} 分钟，距目标从 ${oldRemaining} 分钟变为 ${remaining} 分钟`, oldRemaining, remaining, delta};
}

const CHANGE_PHRASE='改为|改成|设为|设成|设定成|定为|目标(?:改为|是|为)?|达到';
const NOT_GOAL_TARGET=/每天|每日|每次|单次|上限|预算|封顶|最多|不超过|以内/;
const CAP_AFTER=/^\s*(以内|封顶)/;
const HEALTH_TARGET=new RegExp(`(${CHANGE_PHRASE})\\s*(\\d+(?:\\.\\d+)?)\\s*(小时|分钟|分)(?:\\s*(\\d+(?:\\.\\d+)?)\\s*(分钟|分))?`,'g');
const FINANCE_TARGETS=[
  new RegExp(`(${CHANGE_PHRASE})\\s*[¥￥]?\\s*(\\d+(?:,\\d{3})*)\\s*(?:元|块|人民币)`,'g'),
  new RegExp(`(${CHANGE_PHRASE})\\s*[¥￥]\\s*(\\d+(?:,\\d{3})*)`,'g'),
];

// 触发词所在的那一句：数字是否被「每天 30 分钟」这类限定词修饰，只看同一句。
function clauseBefore(message,index) {
  const before=message.slice(0,index);
  const cut=Math.max(before.lastIndexOf('，'),before.lastIndexOf(','),before.lastIndexOf('。'),before.lastIndexOf('；'),before.lastIndexOf(';'),before.lastIndexOf('\n'),before.lastIndexOf('、'));
  return before.slice(cut+1);
}

// 「达到」是达成类动词：只有明确指向目标时才算设定目标，否则只是陈述事实。
function isGoalAssignment(trigger,clause) {
  return trigger!=='达到'||/目标|指标/.test(clause);
}

export function requestedTargetFromMessage(message, domain) {
  if (typeof message !== 'string') return null;
  if (domain === 'custom') return null;
  if (domain === 'health') {
    for (const match of message.matchAll(HEALTH_TARGET)) {
      const clause=clauseBefore(message,match.index);
      if (NOT_GOAL_TARGET.test(clause)) continue;
      if (!isGoalAssignment(match[1],clause)) continue;
      if (CAP_AFTER.test(message.slice(match.index+match[0].length))) continue;
      const base=match[3]==='小时'?Number(match[2])*60:Number(match[2]);
      const minutes=base+(match[4]?Number(match[4]):0);
      if (!Number.isInteger(minutes)||minutes<1||minutes>10080) continue;
      return minutes;
    }
    return null;
  }
  for (const pattern of FINANCE_TARGETS) {
    for (const match of message.matchAll(pattern)) {
      const clause=clauseBefore(message,match.index);
      if (NOT_GOAL_TARGET.test(clause)) continue;
      if (!isGoalAssignment(match[1],clause)) continue;
      if (CAP_AFTER.test(message.slice(match.index+match[0].length))) continue;
      const amount=Number(match[2].replaceAll(',',''));
      if (!Number.isInteger(amount)||amount<1||amount>10000000) continue;
      return amount;
    }
  }
  return null;
}

// 提案预览用的「目标变化」文案：没有提案就没有变化可言，理财金额要按千分位排。
export function goalChangeText(goal, proposal, domain) {
  if (!proposal) return '';
  const plain=value=>Number.isFinite(value)?String(value):'—';
  const money=value=>Number.isFinite(value)?`¥${value.toLocaleString('zh-CN')}`:'—';
  if (domain==='health') return `${plain(goal?.target)} → ${plain(proposal.target)} 分钟 / 周`;
  if (domain==='finance') return `${money(goal?.target)} → ${money(proposal.target)}`;
  return '建立新的自定义目标';
}

function readAgentJSON(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.finalResponse !== 'string') return value;
  const raw = typeof value === 'string' ? value : value?.finalResponse;
  if (typeof raw !== 'string') throw Error('Agent 没有返回内容');
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  try { return JSON.parse(match ? match[1] : raw); }
  catch { throw Error('Agent 返回了无法解析的内容'); }
}

export function validateGoalReply(value, domain, message) {
  const answer = readAgentJSON(value);
  if (typeof answer.reply !== 'string' || !answer.reply.trim() || answer.reply.length > 1200) throw Error('Agent 回复格式不正确');
  let proposal = null;
  if (answer.proposal != null) {
    const p = answer.proposal;
    const limit = domain === 'health' ? 10080 : 10000000;
    const targetValid=domain==='custom' ? p.target==null : Number.isInteger(p.target) && p.target>=1 && p.target<=limit;
    if (!targetValid ||
        typeof p.title !== 'string' || !p.title.trim() || p.title.length > 80 ||
        typeof p.task !== 'string' || !p.task.trim() || p.task.length > 120 ||
        typeof p.reason !== 'string' || !p.reason.trim() || p.reason.length > 300) throw Error('Agent 目标提案不完整');
    proposal = {title:p.title.trim(), target:domain==='custom'?null:p.target, task:p.task.trim(), reason:p.reason.trim()};
  }
  const requested=requestedTargetFromMessage(message,domain);
  if (requested!=null && proposal && proposal.target!==requested) throw Error(`Along 目标数值与用户指定的 ${requested} 不一致`);
  return {reply:answer.reply.trim(), proposal};
}

export function validateTaskReply(value, remaining) {
  const answer = readAgentJSON(value);
  if (typeof answer.task !== 'string' || !answer.task.trim() || answer.task.length > 120 ||
      typeof answer.reason !== 'string' || !answer.reason.trim() || answer.reason.length > 300 ||
      answer.remaining !== remaining) throw Error('Agent 的任务提案与确定性进度不一致');
  return {task:answer.task.trim(), reason:answer.reason.trim(), remaining};
}
