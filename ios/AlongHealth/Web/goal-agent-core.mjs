export function routeHealthChange(before, after, target) {
  const a = before?.workoutMinutes;
  const b = after?.workoutMinutes;
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isInteger(target) || target < 1) return {decision: 'quiet', reason: '尚无可比较的健身记录'};
  const oldRemaining = Math.max(0, target - a);
  const remaining = Math.max(0, target - b);
  const delta = b - a;
  if (delta <= 0) return {decision: 'quiet', reason: '健身时长没有增加'};
  if (oldRemaining === 0 || (delta < 15 && remaining > 0)) return {decision: 'quiet', reason: '变化较小，保留当前任务'};
  return {decision: 'replan', reason: `本周新增 ${delta} 分钟，距目标从 ${oldRemaining} 分钟变为 ${remaining} 分钟`, oldRemaining, remaining, delta};
}

export function requestedTargetFromMessage(message, domain) {
  if (typeof message !== 'string') return null;
  if (domain === 'custom') return null;
  if (domain === 'health') {
    const match = message.match(/(?:改为|改成|设为|设成|定为|目标(?:改为|是|为)?|达到)\s*(\d+(?:\.\d+)?)\s*(小时|分钟|分)/);
    if (!match) return null;
    const minutes = Number(match[1]) * (match[2] === '小时' ? 60 : 1);
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= 10080 ? minutes : null;
  }
  const match = message.match(/(?:改为|改成|设为|设成|定为|目标(?:改为|是|为)?|达到)\s*[¥￥]?\s*(\d+(?:,\d{3})*)\s*(?:元|块|人民币)/);
  if (!match) return null;
  const amount = Number(match[1].replaceAll(',', ''));
  return Number.isInteger(amount) && amount >= 1 && amount <= 10000000 ? amount : null;
}

function readAgentJSON(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.finalResponse !== 'string') return value;
  const raw = typeof value === 'string' ? value : value?.finalResponse;
  if (typeof raw !== 'string') throw Error('Agent 没有返回内容');
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  try { return JSON.parse(match ? match[1] : raw); }
  catch { throw Error('Agent 返回了无法解析的内容'); }
}

export function validateGoalReply(value, domain) {
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
  return {reply:answer.reply.trim(), proposal};
}

export function validateTaskReply(value, remaining) {
  const answer = readAgentJSON(value);
  if (typeof answer.task !== 'string' || !answer.task.trim() || answer.task.length > 120 ||
      typeof answer.reason !== 'string' || !answer.reason.trim() || answer.reason.length > 300 ||
      answer.remaining !== remaining) throw Error('Agent 的任务提案与确定性进度不一致');
  return {task:answer.task.trim(), reason:answer.reason.trim(), remaining};
}
