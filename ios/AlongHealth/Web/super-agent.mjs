export const SUPER_AGENT_RUNS_KEY = 'along.super-agent-runs.v1';

const TASK_STATES = new Set(['temporary', 'planned', 'deferred']);
const DOMAINS = new Set(['health', 'finance']);

const STAGES = [
  {
    progress:18,
    label:'已接收',
    agents:[
      ['working',32,'正在确认任务边界'],
      ['queued',0,'等待获取最小必要情境'],
      ['queued',0,'等待情境结果'],
      ['queued',0,'等待审查方案'],
    ],
  },
  {
    progress:42,
    label:'理解情境',
    agents:[
      ['done',100,'已建立 Ticket 与任务边界'],
      ['working',62,'正在整理目标、进度与约束'],
      ['queued',0,'等待情境结果'],
      ['queued',0,'等待审查方案'],
    ],
  },
  {
    progress:68,
    label:'并行规划',
    agents:[
      ['done',100,'已完成拆解与分工'],
      ['done',100,'已交付可信情境摘要'],
      ['working',58,'正在生成具体行动步骤'],
      ['working',34,'正在检查数据与操作边界'],
    ],
  },
  {
    progress:86,
    label:'检查交付',
    agents:[
      ['done',100,'等待汇总交付'],
      ['done',100,'情境摘要已锁定'],
      ['done',100,'行动方案已交付'],
      ['working',78,'正在完成最后边界审查'],
    ],
  },
  {
    progress:100,
    label:'已就绪',
    agents:[
      ['done',100,'已汇总为可执行交付'],
      ['done',100,'情境摘要已交付'],
      ['done',100,'行动方案已交付'],
      ['done',100,'边界审查已通过'],
    ],
  },
];

function cleanText(value, fallback, max=180) {
  const text=String(value ?? fallback).trim();
  return (text || fallback).slice(0,max);
}

function stableId(value) {
  let hash=2166136261;
  for (const char of String(value)) {
    hash^=char.codePointAt(0);
    hash=Math.imul(hash,16777619);
  }
  return (hash>>>0).toString(36);
}

function roleDefinitions(domain, task) {
  const contextSource=domain==='health' ? 'Apple Health 的已选摘要' : '用户确认的目标与演示结余';
  const boundary=domain==='health' ? '不作医疗判断，不读取未授权的健康数据' : '不访问真实账户，不发起交易或转账';
  return [
    {key:'orchestrator',name:'协调 Agent',mark:'O',role:'Orchestrator',objective:`将「${task.title}」拆成可验收的分工，负责调度与汇总。`,output:'Ticket、Mandate 与执行顺序'},
    {key:'context',name:'情境 Agent',mark:'C',role:'Context',objective:`只从${contextSource}提取完成任务所需的信息。`,output:'目标、进度、时间与约束摘要'},
    {key:'planner',name:'计划 Agent',mark:'P',role:'Planner',objective:`围绕「${task.detail}」形成当下可执行的下一步。`,output:'行动步骤、时机与完成标准'},
    {key:'guardian',name:'守护 Agent',mark:'G',role:'Guardian',objective:`检查方案是否越过用户授权；${boundary}。`,output:'风险边界与待用户确认项'},
  ];
}

function eventLog(step, createdAt) {
  const entries=[
    ['trigger','Along 接收到动态任务触发'],
    ['eval','Eval 根据目标与任务状态接受请求'],
    ['ticket','协调 Agent 创建 Ticket 并设定 Mandate'],
    ['assign','情境、计划与守护 Agent 已分工'],
    ['deliver','各 Agent 产出已汇总，等待用户行动'],
  ];
  return entries.slice(0,Math.min(entries.length,step+2)).map((entry,index)=>({
    id:entry[0],
    text:entry[1],
    at:createdAt+index*60_000,
  }));
}

export function createSuperAgentRun({task, domain='health', goal=null, createdAt=Date.now()}) {
  if (!DOMAINS.has(domain)) throw Error('任务领域无效');
  if (!task || typeof task!=='object') throw Error('动态任务无效');
  const cleanTask={
    id:cleanText(task.id,'task',64).replace(/[^a-z0-9_-]/gi,'-'),
    title:cleanText(task.title,'未命名任务',100),
    detail:cleanText(task.detail,'等待补充任务说明',300),
    when:cleanText(task.when,'现在',80),
    state:TASK_STATES.has(task.state)?task.state:'temporary',
  };
  const initialStep=cleanTask.state==='deferred'?0:cleanTask.state==='temporary'?1:2;
  const id=`ticket-${domain}-${stableId(`${cleanTask.id}:${cleanTask.title}`)}`;
  const run={
    version:1,
    id,
    domain,
    task:cleanTask,
    goal:goal ? {title:cleanText(goal.title,'当前目标',100),target:goal.target ?? null} : null,
    source:{kind:'along.dynamic-task',label:'Along 动态任务'},
    trigger:{kind:'task.opened',label:`${cleanTask.when} · 任务被打开`},
    eval:{decision:cleanTask.state==='deferred'?'observe':'accept',reason:cleanTask.state==='deferred'?'尚未到执行时机，先建立可观察 Ticket。':'任务与当前目标直接相关。'},
    mandate:`只为「${cleanTask.title}」整理下一步；不扩大目标，需要外部操作时等待用户确认。`,
    step:initialStep,
    createdAt,
    updatedAt:createdAt,
  };
  return materializeSuperAgentRun(run);
}

export function materializeSuperAgentRun(value) {
  if (!value || value.version!==1 || !DOMAINS.has(value.domain) || !value.task) throw Error('Super Agent 运行记录无效');
  const step=Math.max(0,Math.min(STAGES.length-1,Number.isInteger(value.step)?value.step:0));
  const stage=STAGES[step];
  const roles=roleDefinitions(value.domain,value.task);
  return {
    ...value,
    step,
    status:stage.progress===100?'done':'working',
    statusLabel:stage.label,
    progress:stage.progress,
    agents:roles.map((role,index)=>({...role,status:stage.agents[index][0],progress:stage.agents[index][1],work:stage.agents[index][2]})),
    events:eventLog(step,value.createdAt),
  };
}

export function advanceSuperAgentRun(value, updatedAt=Date.now()) {
  const run=materializeSuperAgentRun(value);
  return materializeSuperAgentRun({...run,step:Math.min(STAGES.length-1,run.step+1),updatedAt});
}

export function safeSuperAgentRun(value) {
  try { return materializeSuperAgentRun(value); }
  catch { return null; }
}
