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

const CHANGE_PHRASE='改为|改成|设为|设成|设定成|设定为|定为|达到';
// 「目标/指标」直接限定的动词才算指派目标；「今天运动量提高到 150 分钟」这种事实陈述没有目标词，必须留在外面。
const GOAL_PHRASE='(?:目标|指标)(?:改为|是|为|调整为|提高到|减到|调到|调成|改到|改成|设为|设成|设定成|定为)?';
const ANY_CHANGE=`${GOAL_PHRASE}|${CHANGE_PHRASE}`;
const GOAL_WORD=/目标|指标/;
const NOT_GOAL_TARGET=/每天|每日|每次|单次|上限|预算|封顶|最多|不超过|以内/;
// 触发词前一句里的否定与假设：「不要把目标改成 150 分钟」「如果改成 150 分钟就好了」。
// 「别忘了」「不要忘记」是在提醒，不是否定，不能误杀。
const NEGATED_TARGET=/不要(?!忘)|别(?!忘)|不用|不想|不必|勿|无需|没必要|不能|不是|如果|假如|要是|万一|假设/;
// 「下次改成 200 分钟」是改日子的说法，不是现在的指派。
const DEFERRED_TARGET=/下次|以后|之后|回头|再说|将来/;
// 触发词前一句正好说到另一件事时，那个数字不是目标：每月房租设为 2500 元。
// 只看句尾，避免「交完房租把目标改成 12000 元」这种真指派被误杀。
const OTHER_ITEM=/(房租|房费|房贷|学费|水电费|水电|电费|水费|燃气费|燃气|煤气费|餐费|伙食费|宽带费|物业费|话费|网费|车费|油费|饭钱|菜钱|保险费|保险|保费|评分|得分|打分|分数)$/;
// 数字后面的补语：「改成 200 分钟更好」「改成 200 分钟如果天气好」都不是指派。
const QUALIFIED_AFTER=/^\s*[，,。；;]?\s*(以内|封顶|如果|要是|假如|万一|假设|更好|就行|好了|再说)/;
// 金额必须带货币标记：没有货币标记的裸数字可能是公斤、步、岁，读成金额会让整单请求失败。
const HEALTH_TARGET=new RegExp(`(${ANY_CHANGE})\\s*(\\d+(?:\\.\\d+)?)\\s*(小时|分钟|分(?![一-龥]))(?:\\s*(\\d+(?:\\.\\d+)?)\\s*(分钟|分(?![一-龥])))?`,'g');
const FINANCE_TARGETS=[
  new RegExp(`(${ANY_CHANGE})\\s*[¥￥]?\\s*(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(万|萬)?\\s*(?:元|块|人民币)`,'g'),
  new RegExp(`(${ANY_CHANGE})\\s*[¥￥]\\s*(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(万|萬)?`,'g'),
];

// 触发词所在的那一句：数字是否被「每天 30 分钟」这类限定词修饰，只看同一句。
function clauseBefore(message,index) {
  const before=message.slice(0,index);
  const cut=Math.max(before.lastIndexOf('，'),before.lastIndexOf(','),before.lastIndexOf('。'),before.lastIndexOf('；'),before.lastIndexOf(';'),before.lastIndexOf('\n'),before.lastIndexOf('、'));
  return before.slice(cut+1);
}

// 「达到」是达成类动词：只有明确指向目标时才算设定目标，否则只是陈述事实。
function isGoalAssignment(trigger,clause) {
  return trigger!=='达到'||GOAL_WORD.test(clause);
}

// 扫出这条消息里所有「用户真的指派了目标」的候选。
function targetCandidates(message,pattern,readValue) {
  const found=[];
  for (const match of message.matchAll(pattern)) {
    const clause=clauseBefore(message,match.index);
    if (NOT_GOAL_TARGET.test(clause)) continue;
    if (NEGATED_TARGET.test(clause)) continue;
    if (DEFERRED_TARGET.test(clause)) continue;
    if (OTHER_ITEM.test(clause)) continue;
    // 触发词没带目标词时，前面那句话就是在说别的事：「今天运动量改成 150 分钟」
    // 「睡眠改成 8 小时」里的数字不是目标；只有空句或提到目标的句子才算指派。
    if (!GOAL_WORD.test(match[1]) && clause.trim() && !GOAL_WORD.test(clause)) continue;
    if (!isGoalAssignment(match[1],clause)) continue;
    if (QUALIFIED_AFTER.test(message.slice(match.index+match[0].length))) continue;
    const value=readValue(match);
    if (value==null) continue;
    found.push({at:match.index,value});
  }
  return found;
}

export function requestedTargetFromMessage(message, domain) {
  if (typeof message !== 'string') return null;
  if (domain === 'custom') return null;
  if (domain === 'health') {
    const found=targetCandidates(message,HEALTH_TARGET,match=>{
      const base=match[3]==='小时'?Number(match[2])*60:Number(match[2]);
      const minutes=base+(match[4]?Number(match[4]):0);
      return Number.isInteger(minutes)&&minutes>=1&&minutes<=10080?minutes:null;
    });
    return found.length?found[found.length-1].value:null;
  }
  const found=[];
  for (const pattern of FINANCE_TARGETS) {
    found.push(...targetCandidates(message,pattern,match=>{
      const base=Number(match[2].replaceAll(',',''));
      const amount=base*(match[3]==='万'||match[3]==='萬'?10000:1);
      return Number.isInteger(amount)&&amount>=1&&amount<=10000000?amount:null;
    }));
  }
  // 用户改口时以最后一次为准：「目标改成 150 分钟，目标改成 180 分钟」取 180。
  found.sort((a,b)=>a.at-b.at);
  return found.length?found[found.length-1].value:null;
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
