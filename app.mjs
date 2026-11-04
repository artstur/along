import {KEY, loadState, setSnapshot} from './health.mjs';
import {ACTIVE_GOAL_KEY, FINANCE_KEY, ensureHealthGoal, loadFinance, connectFinanceDemo, addFinanceDemoRecord, healthView, financeView} from './workspace.mjs';
import {EXPERIMENT, startExperiment, routeHealthEvent, acceptAgentSuggestion, agentRequestPayload} from './loop.mjs';
import {routeHealthChange} from './goal-agent-core.mjs';
import {AGENT_KEY, GOALS_KEY, CONVERSATIONS_KEY, readStored, agentCall} from './agent-client.mjs';
import {ADAPTIVE_LAYOUTS_KEY, safeAdaptiveLayout, validateAdaptiveLayout} from './adaptive-ui.mjs';
import {SUPER_AGENT_RUNS_KEY, advanceSuperAgentRun, createSuperAgentRun, safeSuperAgentRun} from './super-agent.mjs';
const TICKET_KEY = 'along.goal-ticket.v1';

const app = document.querySelector('#app');
const sheet = document.querySelector('#sheet');
const toast = document.querySelector('#toast');
let state = ensureHealthGoal(loadState(localStorage.getItem(KEY)));
let finance = loadFinance(localStorage.getItem(FINANCE_KEY));
let activeGoal = ['finance','custom'].includes(localStorage.getItem(ACTIVE_GOAL_KEY)) ? localStorage.getItem(ACTIVE_GOAL_KEY) : 'health';
let screen = 'home';
let selectedTaskId = null;
let running = false;
let agentBusy = false;
let agentConfig = readStored(AGENT_KEY, {});
let goalCustom = readStored(GOALS_KEY, {health:null, finance:null, custom:null});
let conversations = readStored(CONVERSATIONS_KEY, {health:[], finance:[], custom:[]});
const storedLayouts = readStored(ADAPTIVE_LAYOUTS_KEY, {health:null, finance:null, custom:null});
let goalLayouts = {health:safeAdaptiveLayout(storedLayouts.health,'health'), finance:safeAdaptiveLayout(storedLayouts.finance,'finance'), custom:safeAdaptiveLayout(storedLayouts.custom,'custom')};
let pendingTask = readStored(TICKET_KEY, null);
let superAgentRuns = readStored(SUPER_AGENT_RUNS_KEY, {});
function saveTicket(ticket) { pendingTask=ticket; if (ticket) localStorage.setItem(TICKET_KEY,JSON.stringify(ticket)); else localStorage.removeItem(TICKET_KEY); }
localStorage.setItem(KEY, JSON.stringify(state));

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const formatDate = value => new Intl.DateTimeFormat('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}).format(new Date(value));
const formatTime = value => new Intl.DateTimeFormat('zh-CN', {hour:'2-digit', minute:'2-digit'}).format(new Date(value));
function notice(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3200);
}
function saveHealth(next) {
  state = ensureHealthGoal(next);
  localStorage.setItem(KEY, JSON.stringify(state));
  if (screen !== 'agent') render();
}
function saveFinance(next) {
  finance = next;
  localStorage.setItem(FINANCE_KEY, JSON.stringify(finance));
  render();
}
function show(html) {
  sheet.innerHTML = html;
  sheet.showModal();
}

function brand() {
  return `<div class="brand"><span class="brand-symbol" aria-hidden="true">A<span>·</span></span><span>along</span></div>`;
}
function customView() {
  return {
    id:'custom',category:'自定义目标',title:goalCustom.custom?.title || '定义一个真正属于你的目标',measure:'—',measureUnit:'',percent:0,
    progressText:'先把想实现的改变告诉 Codex',note:'Codex 会整理目标、待确认信息和动态任务；采用后才更新首页。',
    primary:{title:'从一句话开始',detail:'可以包含期限、偏好、限制、已知条件和你不希望发生的事情。',status:'待定义'},secondary:[],connection:null,
  };
}
const taskStateLabel={temporary:'临时',planned:'已规划',deferred:'到时生成'};
const agentStateLabel={queued:'等待',working:'工作中',done:'已完成'};
function currentTaskRecords() {
  const layout=goalLayouts[activeGoal];
  if (layout) return layout.tasks;
  const model=activeGoal==='finance'?financeView(finance,goalCustom.finance):healthView(state,goalCustom.health);
  const normalize=(task,id,index)=>({
    id,
    when:index===0?(task.status || '现在'):(task.status || '之后'),
    title:task.title,
    detail:task.detail,
    state:index===0?'planned':'deferred',
  });
  return [normalize(model.primary,'primary',0),...model.secondary.map((task,index)=>normalize(task,`follow-up-${index}`,index+1))];
}
function saveSuperAgentRuns() { localStorage.setItem(SUPER_AGENT_RUNS_KEY,JSON.stringify(superAgentRuns)); }
function runKey(taskId) { return `${activeGoal}:${taskId}`; }
function selectedTask() { return currentTaskRecords().find(task=>task.id===selectedTaskId) || null; }
function currentSuperAgentRun(task) {
  const key=runKey(task.id);
  const saved=safeSuperAgentRun(superAgentRuns[key]);
  if (saved) return saved;
  const created=createSuperAgentRun({task,domain:activeGoal,goal:currentGoal()});
  superAgentRuns={...superAgentRuns,[key]:created};
  saveSuperAgentRuns();
  return created;
}
function trustedMetric(source) {
  if (activeGoal==='finance') return source==='saved' && finance.connected ? finance.saved : null;
  const selected=state.snapshot?.selectedTypes;
  const type={workoutMinutes:'workout',sleepMinutes:'sleep',weightKg:'weight'}[source];
  if (!state.snapshot || (state.source==='healthkit' && Array.isArray(selected) && !selected.includes(type))) return null;
  const value=state.snapshot[source];
  return Number.isFinite(value)?value:null;
}
function adaptiveModule(module, compact=true) {
  if (module.kind==='summary') return `<div class="adaptive-module"><span class="module-title">${esc(module.title)}</span><p>${esc(module.content)}</p></div>`;
  if (module.kind==='fact_list') {
    const items=compact?module.items.slice(0,2):module.items;
    return `<div class="adaptive-module"><span class="module-title">${esc(module.title)}</span><div class="adaptive-facts">${items.map(item=>`<div><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong></div>`).join('')}</div>${compact&&module.items.length>items.length?`<p class="module-more">另有 ${module.items.length-items.length} 项已收起</p>`:''}</div>`;
  }
  if (module.kind==='chips') return `<div class="adaptive-module"><span class="module-title">${esc(module.title)}</span><div class="adaptive-chips">${module.items.map(item=>`<span>${esc(item)}</span>`).join('')}</div></div>`;
  const value=trustedMetric(module.source), numericTarget=typeof module.target==='number'?module.target:null;
  const percent=value!=null&&numericTarget?Math.min(100,Math.max(0,Math.round(value/numericTarget*100))):0;
  return `<div class="adaptive-module adaptive-metric"><span class="module-title">${esc(module.title)}</span><div class="metric-value"><strong>${value==null?'—':esc(value)}</strong><span>/ ${esc(module.target)} ${esc(module.unit)}</span></div>${numericTarget?`<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>`:''}${module.note?`<p>${esc(module.note)}</p>`:''}</div>`;
}
function adaptiveGoalCard(layout) {
  const context=layout.modules.find(module=>module.kind==='chips') || layout.modules.find(module=>module.kind==='fact_list') || layout.modules.find(module=>module.kind==='summary');
  const metric=layout.modules.find(module=>module.kind==='metric');
  const visible=[context,metric].filter(Boolean),visibleIds=new Set(visible.map(module=>module.id));
  const more=layout.modules.filter(module=>!visibleIds.has(module.id));
  return `<section class="goal-card adaptive-goal" aria-label="Agent 生成的目标空间"><div class="goal-card-top"><span class="eyebrow">当前目标</span>${layout.badge?`<span class="layout-badge">${esc(layout.badge)}</span>`:''}</div><h1>${esc(layout.title)}</h1><p class="adaptive-summary">${esc(layout.summary)}</p>${visible.map(module=>adaptiveModule(module,true)).join('')}${more.length?`<details class="adaptive-more"><summary>查看目标详情 · ${more.length} 个模块</summary>${more.map(module=>adaptiveModule(module,false)).join('')}</details>`:''}<div class="card-actions"><button class="agent-action" data-action="edit-goal">编辑目标</button></div></section>`;
}
function adaptiveTaskSection(layout) {
  const visible=layout.tasks.slice(0,2),hidden=Math.max(0,layout.tasks.length-visible.length);
  return `<section class="task-section adaptive-tasks" aria-label="动态任务"><div class="section-heading"><h2>动态任务</h2><span>Agent 根据目标与情境生成</span></div><div class="adaptive-task-card"><div class="generated-status">${layout.tasks.length} 项已生成 · 点击查看 Agent 协作</div>${visible.map(task=>`<button class="generated-task generated-task-button" data-action="open-task" data-task-id="${esc(task.id)}"><div class="task-meta"><span>${esc(task.when)}</span><span class="state-pill">${esc(taskStateLabel[task.state])}</span></div><strong>${esc(task.title)}</strong><p>${esc(task.detail)}</p><span class="task-open-hint">Agent 工作视图 <b aria-hidden="true">→</b></span></button>`).join('')}${hidden?`<p class="hidden-count">还有 ${hidden} 项未来触发任务，将在相关时间出现。</p>`:''}${layout.questions.length?`<div class="missing-strip">待确认 ${layout.questions.length} 项：${esc(layout.questions[0])}</div>`:''}<div class="card-actions"><button class="agent-action" data-action="edit-goal">补充信息</button></div></div></section>`;
}
function home() {
  const model = activeGoal === 'finance' ? financeView(finance, goalCustom.finance) : activeGoal==='custom' ? customView() : healthView(state, goalCustom.health);
  const layout=goalLayouts[activeGoal];
  const connection = model.connection;
  const sourceTime = activeGoal === 'health' && state.snapshot?.updatedAt && state.source === 'healthkit'
    ? ` · ${formatDate(state.snapshot.updatedAt)} 已检查` : '';
  const goalContent=layout?adaptiveGoalCard(layout):`<section class="goal-card" aria-label="${esc(model.category)}">
        <div class="goal-card-top"><span class="eyebrow">${esc(model.category)}</span><button class="goal-edit" data-action="edit-goal">与 Agent 编辑目标 ↗</button></div>
        <h1>${esc(model.title)}</h1>
        <div class="goal-numbers"><strong>${esc(model.measure)}</strong><span>${esc(model.measureUnit)}</span></div>
        <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${model.percent}" aria-label="目标进度"><span style="width:${model.percent}%"></span></div>
        <p class="progress-caption">${esc(model.progressText)}</p>
        <p class="goal-note">${esc(model.note)}</p>
      </section>`;
  const taskContent=layout?adaptiveTaskSection(layout):`<section class="task-section" aria-label="动态任务">
        <div class="section-heading"><h2>动态任务</h2><span>随目标与数据更新</span></div>
        <button class="focus-task task-card-button" data-action="open-task" data-task-id="primary"><div class="focus-top"><span>下一步</span><span class="task-chip">${esc(model.primary.status)}</span></div><h3>${esc(model.primary.title)}</h3><p>${esc(model.primary.detail)}</p><span class="focus-open-hint">Agent 工作视图 →</span></button>
        ${pendingTask && activeGoal === 'health' ? `<div class="task-proposal"><span>HealthKit 变化 → 路由判断 → ${pendingTask.suggestion?'Codex 提案 → 等待你确认':'等待 Codex'}</span><p>${esc(pendingTask.reason)}</p>${pendingTask.suggestion ? `<strong>${esc(pendingTask.suggestion.task)}</strong><p>${esc(pendingTask.suggestion.reason)}</p><button class="button" data-action="accept-task">采用这一步</button> <button class="button secondary" data-action="dismiss-task">保留原任务</button>` : `<p>${esc(pendingTask.error || 'Codex 正在规划下一步…')}</p>`}</div>` : ''}
        ${model.secondary.length ? `<div class="task-list">${model.secondary.map((task,index) => `<button class="task-row task-row-button" data-action="open-task" data-task-id="follow-up-${index}"><span class="task-row-mark" aria-hidden="true"></span><div><strong>${esc(task.title)}</strong><p>${esc(task.detail)}</p></div><span class="task-row-status">${esc(task.status)} →</span></button>`).join('')}</div>` : ''}
      </section>`;
  const connectionContent=connection?`<section class="connection-section" aria-label="连接来源">
        <div class="section-heading"><h2>连接</h2><span>只显示与当前目标相关的来源</span></div>
        <div class="connection-card"><div class="connection-symbol" aria-hidden="true">${activeGoal === 'health' ? '♥' : '¥'}</div><div class="connection-copy"><div class="connection-name"><strong>${esc(connection.name)}</strong><span class="source-tag ${connection.kind}">${esc(connection.label)}</span></div><p>${esc(connection.detail)}${esc(sourceTime)}</p></div><button class="connection-action" data-action="${activeGoal === 'health' ? 'connect-health' : connection.kind === 'demo' ? 'finance-event' : 'connect-finance'}">${esc(connection.action)}</button></div>
        ${connection.metrics?.length ? `<div class="connection-metrics">${connection.metrics.map(item=>`<div><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong></div>`).join('')}</div>` : ''}
        ${state.source === 'demo' && activeGoal === 'health' ? '<button class="minor-action" data-action="clear-health-demo">退出健康演示数据</button>' : ''}
        ${activeGoal === 'health' && state.source === 'healthkit' ? '<p class="connection-footnote">打开 App 或前台健康记录变化时自动刷新；有意义的变化才请 Agent 重排。</p>' : ''}
        ${activeGoal === 'finance' && finance.connected ? '<p class="connection-footnote">点“模拟 +¥800”只会更新这份本机演示数据，不会访问账户或发起交易。</p>' : ''}
      </section>`:'';
  return `<div class="app-shell"><header class="topbar"><div class="topbar-inner">${brand()}<span class="topbar-caption">你的目标空间</span></div></header>
    <main class="content ${layout?'adaptive-space':''}">
      <div class="goal-switch"><label for="goal-select">当前目标</label><div class="select-wrap"><select id="goal-select" aria-label="切换目标"><option value="health" ${activeGoal === 'health' ? 'selected' : ''}>健康 · ${goalLayouts.health?'个性化计划':'每周运动'}</option><option value="finance" ${activeGoal === 'finance' ? 'selected' : ''}>理财 · ${goalLayouts.finance?'个性化计划':'应急储备'}</option><option value="custom" ${activeGoal === 'custom' ? 'selected' : ''}>${goalLayouts.custom?'我的自定义目标':'＋ 定义新目标'}</option></select><span aria-hidden="true">⌄</span></div></div>
      ${goalContent}
      ${taskContent}
      ${connectionContent}
      ${activeGoal === 'health' ? '<button class="lab-entry" data-action="open-lab">查看目标变化实验 <span aria-hidden="true">↗</span></button>' : ''}
    </main><footer>Along · 一起，慢慢向前</footer></div>`;
}

function taskAgentCard(agent) {
  return `<article class="worker-card ${agent.status}"><div class="worker-card-head"><span class="worker-mark" aria-hidden="true">${esc(agent.mark)}</span><div><strong>${esc(agent.name)}</strong><span>${esc(agent.role)}</span></div><span class="worker-state">${esc(agentStateLabel[agent.status])}</span></div><p class="worker-objective">${esc(agent.objective)}</p><div class="worker-progress"><span style="width:${agent.progress}%"></span></div><p class="worker-now"><span>当前</span>${esc(agent.work)}</p><p class="worker-output"><span>交付</span>${esc(agent.output)}</p></article>`;
}
function taskDetailPage() {
  const task=selectedTask();
  if (!task) {
    return `<div class="app-shell"><header class="topbar"><div class="topbar-inner">${brand()}<span class="topbar-caption">Super Agent</span></div></header><main class="content task-detail"><button class="back-button" data-action="task-back">← 返回动态任务</button><div class="empty-task"><h1>任务已更新</h1><p>这项动态任务已不在当前计划中，请返回查看最新安排。</p></div></main></div>`;
  }
  const run=currentSuperAgentRun(task);
  return `<div class="app-shell super-agent-shell"><header class="topbar"><div class="topbar-inner">${brand()}<span class="topbar-caption">Super Agent · 任务协作</span></div></header><main class="content task-detail">
    <button class="back-button" data-action="task-back">← 返回动态任务</button>
    <section class="task-hero"><div class="task-hero-top"><span class="eyebrow">${esc(task.when)} · ${esc(taskStateLabel[task.state])}</span><span class="run-status ${run.status}"><i></i>${esc(run.statusLabel)}</span></div><h1>${esc(task.title)}</h1><p>${esc(task.detail)}</p><div class="run-progress-head"><span>总体进展</span><strong>${run.progress}%</strong></div><div class="run-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${run.progress}"><span style="width:${run.progress}%"></span></div></section>

    <section class="orchestration-section"><div class="section-heading"><h2>编排链路</h2><span>从触发到可交付 Ticket</span></div><div class="orchestration-flow">
      <div><span>Source</span><strong>${esc(run.source.label)}</strong></div><b aria-hidden="true">→</b>
      <div><span>Trigger</span><strong>${esc(run.trigger.label)}</strong></div><b aria-hidden="true">→</b>
      <div><span>Eval</span><strong>${run.eval.decision==='accept'?'接受执行':'观察等待'}</strong></div><b aria-hidden="true">→</b>
      <div><span>Ticket</span><strong>${esc(run.id.replace(/^ticket-/,''))}</strong></div>
    </div><div class="mandate-card"><span>Mandate · 本次授权边界</span><p>${esc(run.mandate)}</p></div></section>

    <section class="workers-section"><div class="section-heading"><h2>Agent 分工</h2><span>${run.agents.filter(agent=>agent.status==='done').length} / ${run.agents.length} 已完成</span></div><div class="worker-grid">${run.agents.map(taskAgentCard).join('')}</div></section>

    <section class="activity-section"><div class="section-heading"><h2>工作记录</h2><span>只记录有意义的状态变化</span></div><div class="activity-list">${run.events.map((event,index)=>`<div class="activity-row"><span class="activity-dot ${index===run.events.length-1&&run.status!=='done'?'active':''}"></span><div><strong>${esc(event.text)}</strong><span>${formatTime(event.at)}</span></div></div>`).join('')}</div></section>

    <aside class="architecture-note"><strong>当前实现边界</strong><p>这是 Along 内的可解释编排层：它按 Super Agent 的 Ticket、Mandate 和 Assignment 模型展示任务。Agent 进度来自本地工作流状态，不代表四个模型正在后台长期运行。</p></aside>
  </main></div>`;
}

function agentPreview(item,index,goal,domain) {
  if (!item.proposal && !item.layout) return '';
  const change=domain==='health'?`${goal.target} → ${item.proposal?.target} 分钟 / 周`:domain==='finance'?`¥${goal.target.toLocaleString('zh-CN')} → ¥${item.proposal?.target.toLocaleString('zh-CN')}`:'建立新的自定义目标';
  const goalChange=item.proposal?`<span>目标变化：${change}</span><strong>${esc(item.proposal.title)}</strong><p>下一步：${esc(item.proposal.task)}</p><p>${esc(item.proposal.reason)}</p>`:'';
  const layoutPreview=item.layout?`<span>Agent 生成的目标空间</span><strong>${esc(item.layout.title)}</strong><p>${esc(item.layout.summary)}</p><p>${item.layout.modules.length} 个目标模块 · ${item.layout.tasks.length} 项动态任务 · ${item.layout.questions.length} 项待确认</p>`:'';
  return `<div class="proposal-preview">${goalChange}${layoutPreview}<button class="button" data-action="accept-goal" data-index="${index}">${item.proposal?'确认采用目标与界面':'采用这个目标空间'}</button></div>`;
}
function goalAgentPage() {
  const domain=activeGoal;
  const goal=currentGoal();
  const history=conversations[domain] || [];
  const label=domain==='health'?'健康':domain==='finance'?'理财演示':'自定义目标';
  const targetText=domain==='health'?`${goal.target} 分钟 / 周`:domain==='finance'?`¥${goal.target.toLocaleString('zh-CN')}`:'由你用自然语言定义';
  const placeholder=domain==='custom'?'例如：未来半年完成第一部长篇小说，每周只有周末能集中写作':'例如：这周运动目标改为 150 分钟，但每天只有 20 分钟';
  return `<div class="app-shell"><header class="topbar"><div class="topbar-inner">${brand()}<span class="topbar-caption">目标共创</span></div></header><main class="content agent-page"><button class="back-button" data-action="agent-back">← 返回目标</button><div class="agent-title"><span class="eyebrow">${label} · Codex Agent</span><h1>${esc(goal.title)}</h1><p>当前目标：${targetText}。你提出想法，Codex 生成目标空间和动态任务；确认后才会改变首页。</p></div>
  ${agentConfig.token ? `<div class="agent-status">已配对本地 Mac · ${esc(agentConfig.baseURL)} <button data-action="disconnect-agent">重新配对</button></div>` : `<div class="agent-setup"><h2>连接这台 Mac 上的 Codex</h2><p>Mac 与 iPhone 保持在同一 Wi‑Fi。在 Mac 运行 <code>npm run agent-host</code>，填入终端显示的地址、SHA-256 指纹和一次性配对码。</p><form id="pair-form"><input name="baseURL" placeholder="https://192.168.x.x:4176" value="${esc(agentConfig.baseURL||'')}" required><input name="fingerprint" placeholder="证书指纹 SHA-256" value="${esc(agentConfig.fingerprint||'')}" required><input name="code" placeholder="一次性配对码" inputmode="numeric" required><button class="button" ${agentBusy?'disabled':''}>${agentBusy?'连接中…':'连接 Mac Agent'}</button></form></div>`}
  <div class="agent-messages">${history.length?history.map((item,index)=>`<div class="agent-message ${item.role}"><span>${item.role==='user'?'你':'Codex Agent'}</span><p>${esc(item.text)}</p>${agentPreview(item,index,goal,domain)}</div>`).join(''):'<p class="agent-empty">说说你希望达成什么、期限、约束和偏好；Codex 会先整理并请你确认。</p>'}</div>
  <form id="agent-form" class="agent-composer"><textarea name="message" placeholder="${placeholder}" maxlength="800" required></textarea><button class="button" ${agentBusy||!agentConfig.token?'disabled':''}>${agentBusy?'Codex 正在思考…':'发送给 Codex'}</button></form><p class="agent-disclaimer">${domain==='finance'?'理财连接和余额仍是演示；Codex 只规划，不交易。':domain==='health'?'仅发送当前目标与所选健康摘要，不发送原始记录。':'只发送你在目标对话中主动提供的信息。'}</p></main></div>`;
}

function currentGoal() {
  return activeGoal==='health' ? {domain:'health',title:goalCustom.health?.title || `本周累计运动 ${state.goals.find(item=>item.type==='workout')?.target||120} 分钟`,target:state.goals.find(item=>item.type==='workout')?.target||120} : activeGoal==='finance' ? {domain:'finance',title:goalCustom.finance?.title || '三个月存下 ¥10,000 应急金',target:goalCustom.finance?.target||10000} : {domain:'custom',title:goalCustom.custom?.title || '定义我的新目标',target:null};
}
function currentSummary() {
  return activeGoal==='health' ? {workoutMinutes:state.snapshot?.workoutMinutes ?? null,selectedTypes:state.source==='healthkit' && state.snapshot?.selectedTypes?.includes('workout')?['workout']:[]} : activeGoal==='finance' ? {saved:finance.connected?finance.saved:null} : {};
}
function saveConversations() { localStorage.setItem(CONVERSATIONS_KEY,JSON.stringify(conversations)); }
function saveGoalCustom() { localStorage.setItem(GOALS_KEY,JSON.stringify(goalCustom)); }
function saveGoalLayouts() { localStorage.setItem(ADAPTIVE_LAYOUTS_KEY,JSON.stringify(goalLayouts)); }

function experimentPanel() {
  const loop = state.loop?.experiment === EXPERIMENT ? state.loop : null;
  const latest = loop?.changes?.find(item => item.decision === 'replan');
  const quiet = loop?.changes?.filter(item => item.decision === 'quiet').length ?? 0;
  return `<section class="lab-card">${loop ? `<div class="lab-head"><div><strong>本周健身 120 分钟</strong><p>从 75 分钟开始，观察任务何时改变。</p></div><button class="minor-action" data-action="experiment-reset">重新开始</button></div><div class="lab-actions"><button class="button" data-action="event-workout-35" ${running ? 'disabled' : ''}>新增 35 分钟</button><button class="button secondary" data-action="event-workout-1" ${running ? 'disabled' : ''}>仅新增 1 分钟</button><button class="button secondary" data-action="event-steps" ${running ? 'disabled' : ''}>仅步数变化</button></div>${latest ? `<div class="change-card"><span class="eyebrow">${latest.status === 'pending' ? '正在请求 Codex…' : latest.status === 'error' ? '建议暂不可用' : latest.source === 'live-codex' ? 'Codex 实时建议' : 'Agent 建议回放'}</span><div class="change-flow"><div><span>原任务</span><strong>${esc(latest.beforeTask)}</strong></div><span class="flow-arrow">→</span><div><span>新任务</span><strong>${esc(latest.suggestion?.task ?? (latest.status === 'error' ? '尚未生成' : '生成中…'))}</strong></div></div><p>${latest.remainingBefore} → ${latest.remainingAfter} 分钟待完成。${esc(latest.reason)} ${esc(latest.suggestion?.reason ?? '')}</p>${latest.status === 'error' ? `<p>${esc(latest.error)}</p>` : ''}${latest.source === 'recorded-dsh' ? '<p>公网版显示已录制的历史 Agent 运行结果。</p>' : ''}</div>` : '<p class="lab-hint">轻微或无关变化会安静处理；显著变化才请求新任务。</p>'}${quiet ? `<p class="lab-hint">${quiet} 条变化已安静处理，没有调用 Codex。</p>` : ''}` : `<div class="lab-head"><div><strong>看一次目标驱动的调整</strong><p>预设本周 120 分钟、已完成 75 分钟。</p></div></div><button class="button lab-start" data-action="experiment-start">开始实验</button>`}</section>`;
}
function lab() {
  return `<div class="app-shell"><header class="topbar"><div class="topbar-inner">${brand()}<span class="topbar-caption">目标变化实验</span></div></header><main class="content lab-content"><button class="back-button" data-action="back-home">← 返回目标</button><h1>当进度变化，下一步会怎样变？</h1><p class="lab-intro">这是与真实健康数据隔离的模拟实验。Along 计算进度，再判断是否需要 Codex 建议。</p>${experimentPanel()}</main></div>`;
}
function render() { app.innerHTML = screen === 'lab' ? lab() : screen === 'agent' ? goalAgentPage() : screen === 'task' ? taskDetailPage() : home(); }

function connectInfo() {
  show(`<div class="sheet-head"><h2>连接 Apple Health</h2><button class="icon-button" data-action="close" aria-label="关闭">×</button></div><p class="sheet-copy">只有 iPhone App 可以读取 Apple Health。你可逐项选择、预览摘要，再决定是否导入本机 Along。</p><div class="permission-list"><span>步数</span><span>健身</span><span>体重</span><span>睡眠</span></div><button class="button sheet-main-button" data-action="health-demo">先体验演示数据</button><p class="sheet-footnote">演示数据不会显示为真实连接。</p>`);
}
async function connectHealth() {
  if (!window.AlongHealthBridge?.connect) { connectInfo(); return; }
  try {
    const snapshot = await window.AlongHealthBridge.connect({types:['steps','weight','workout','sleep']});
    saveHealth(setSnapshot(state, snapshot, 'healthkit'));
    notice('健康数据已导入本机');
  } catch (error) { notice(error?.message || '连接未完成，请检查健康权限'); }
}

async function injectEvent(event) {
  if (running) return;
  const before = state;
  let route;
  try { route = routeHealthEvent(before, event); } catch (error) { notice(error.message); return; }
  const id = crypto.randomUUID();
  const entry = {id, type:event.type, amount:event.amount, decision:route.decision, reason:route.reason, remainingBefore:route.remainingBefore, remainingAfter:route.remainingAfter, beforeTask:before.loop.currentTask, status:route.decision === 'quiet' ? 'quiet' : 'pending'};
  if (route.decision === 'replan') running = true;
  saveHealth({...route.after, loop:{...before.loop, changes:[entry, ...before.loop.changes]}});
  if (route.decision === 'quiet') return;
  try {
    let result;
    const localAgent = ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!localAgent && before.snapshot.workoutMinutes === 75 && event.type === 'workout' && event.amount === 35) {
      const replay = await fetch('./agent-replay.json').then(response => response.json());
      if (replay.experiment !== EXPERIMENT || replay.beforeMinutes !== 75 || replay.eventMinutes !== 35) throw Error('回放场景不匹配');
      result = {decision:'replan', source:'recorded-dsh', suggestion:replay.suggestion};
    } else if (localAgent) {
      const response = await fetch('./api/health-event', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(agentRequestPayload(before, event))});
      result = await response.json();
      if (!response.ok) throw Error(result.error || 'Codex 请求失败');
    } else throw Error('公网演示仅提供 75＋35 分钟场景的历史 Agent 回放');
    if (result.decision !== 'replan') throw Error('服务端没有确认重排');
    const suggestion = acceptAgentSuggestion(JSON.stringify(result.suggestion), route.remainingAfter);
    if (state.loop?.changes?.[0]?.id !== id) return;
    saveHealth({...state, loop:{...state.loop, currentTask:suggestion.task, changes:[{...entry, status:'done', suggestion, source:result.source}, ...state.loop.changes.slice(1)]}});
  } catch (error) {
    if (state.loop?.changes?.[0]?.id === id) saveHealth({...state, loop:{...state.loop, changes:[{...entry, status:'error', error:error.message}, ...state.loop.changes.slice(1)]}});
  } finally { running = false; render(); }
}

app.addEventListener('change', event => {
  if (event.target.id !== 'goal-select') return;
  activeGoal = ['finance','custom'].includes(event.target.value) ? event.target.value : 'health';
  localStorage.setItem(ACTIVE_GOAL_KEY, activeGoal);
  if (activeGoal==='custom' && !goalLayouts.custom) screen='agent';
  render();
});
app.addEventListener('click', event => {
  const actionTarget=event.target.closest('[data-action]');
  const action = actionTarget?.dataset.action;
  if (!action) return;
  if (action === 'open-task') {
    selectedTaskId=actionTarget.dataset.taskId || null;
    if (!selectedTaskId) return;
    screen='task';
    render();
  }
  if (action === 'task-back') { selectedTaskId=null;screen='home';render(); }
  if (action === 'edit-goal') { screen='agent'; render(); }
  if (action === 'agent-back') { screen='home'; render(); }
  if (action === 'disconnect-agent') { agentConfig={};localStorage.removeItem(AGENT_KEY);render(); }
  if (action === 'accept-goal') {
    const index=Number(event.target.dataset.index),item=conversations[activeGoal]?.[index];
    if (!item?.proposal && !item?.layout) return;
    if (item.proposal) {
      goalCustom[activeGoal]={...item.proposal};
      saveGoalCustom();
      if (activeGoal==='health') saveHealth({...state,goals:state.goals.map(goal=>goal.type==='workout'?{...goal,target:item.proposal.target}:goal)});
    }
    if (item.layout) {
      goalLayouts[activeGoal]=validateAdaptiveLayout(item.layout,activeGoal);
      saveGoalLayouts();
    }
    conversations[activeGoal]=conversations[activeGoal].map((entry,i)=>i===index?{...entry,proposal:null,layout:null}:entry);
    saveConversations();
    screen='home';render();notice(item.proposal?'目标、界面和下一步已更新':'目标空间已更新');
  }
  if (action === 'accept-task' && pendingTask?.suggestion) {
    goalCustom.health={...goalCustom.health,task:pendingTask.suggestion.task,reason:pendingTask.suggestion.reason};
    saveGoalCustom();saveTicket(null);render();notice('下一步已更新');
  }
  if (action === 'dismiss-task') { saveTicket(null);render(); }
  if (action === 'connect-health') connectHealth();
  if (action === 'connect-finance') { saveFinance(connectFinanceDemo()); notice('已打开理财演示连接'); }
  if (action === 'finance-event') { saveFinance(addFinanceDemoRecord(finance,goalCustom.finance?.target||10000)); notice('已记录一笔 +¥800 演示结余'); }
  if (action === 'clear-health-demo') { saveHealth({...state, source:null, snapshot:null}); notice('已退出健康演示数据'); }
  if (action === 'open-lab') { screen = 'lab'; render(); }
  if (action === 'back-home') {
    screen = 'home';
    if (state.loop?.experiment === EXPERIMENT) saveHealth(state.loop.previousState ?? loadState(null));
    else render();
  }
  if (action === 'experiment-start' || action === 'experiment-reset') { if (!running) saveHealth(startExperiment(state)); }
  if (action === 'event-workout-35') injectEvent({type:'workout', amount:35});
  if (action === 'event-workout-1') injectEvent({type:'workout', amount:1});
  if (action === 'event-steps') injectEvent({type:'steps', amount:100});
});
app.addEventListener('submit', async event => {
  if (!['pair-form','agent-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (agentBusy) return;
  agentBusy=true;
  const form=new FormData(event.target);
  try {
    if (event.target.id==='pair-form') {
      const config={baseURL:String(form.get('baseURL')).trim().replace(/\/$/,''),fingerprint:String(form.get('fingerprint')).trim().replace(/[^a-fA-F0-9]/g,'').toUpperCase()};
      const result=await agentCall(config,'/pair',{code:String(form.get('code')).trim()});
      agentConfig={...config,token:result.token};
      localStorage.setItem(AGENT_KEY,JSON.stringify(agentConfig));
      notice('已连接本地 Codex Agent');
    } else {
      const message=String(form.get('message')).trim();
      if (!message) return;
      const domain=activeGoal;
      const history=conversations[domain]||[];
      const result=await agentCall(agentConfig,'/goal/chat',{goal:currentGoal(),snapshot:currentSummary(),message,history:history.map(item=>({role:item.role,text:item.text}))});
      conversations[domain]=[...history,{role:'user',text:message},{role:'assistant',text:result.reply,proposal:result.proposal,layout:result.layout}].slice(-20);
      saveConversations();
    }
  } catch(error) { notice(error.message || 'Agent 请求失败'); }
  finally { agentBusy=false;render(); }
});
window.addEventListener('along-health-update', async event => {
  if (state.loop?.experiment === EXPERIMENT) return;
  const before=state.snapshot;
  const beforeSource=state.source;
  let next;
  try { next=setSnapshot(state,event.detail,'healthkit'); }
  catch { return; }
  saveHealth(next);
  if (!before || beforeSource!=='healthkit') return;
  const goal={domain:'health',title:goalCustom.health?.title || '本周运动',target:state.goals.find(item=>item.type==='workout')?.target||120};
  const route=routeHealthChange(before,next.snapshot,goal.target);
  if (route.decision==='quiet') return;
  const ticket={id:crypto.randomUUID(),source:'healthkit',trigger:{from:before.workoutMinutes,to:next.snapshot.workoutMinutes},eval:route.decision,mandate:'仅提出任务，用户确认后才采用',reason:route.reason,status:'assigned'};
  if (!agentConfig.token) { saveTicket({...ticket,status:'waiting',error:'Mac Agent 未连接；进度已更新，任务可稍后再规划。'});if (screen==='home') render();return; }
  saveTicket(ticket);if (screen==='home') render();
  try {
    const result=await agentCall(agentConfig,'/goal/event',{goal,before:{workoutMinutes:before.workoutMinutes,selectedTypes:['workout']},after:{workoutMinutes:next.snapshot.workoutMinutes,selectedTypes:['workout']},currentTask:goalCustom.health?.task||healthView(state).primary.title});
    if (result.decision==='replan') saveTicket({...ticket,status:'proposed',reason:result.reason,suggestion:result.suggestion});
    else saveTicket(null);
  } catch(error) { saveTicket({...ticket,status:'waiting',error:error.message}); }
  if (screen==='home') render();
});
sheet.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'close') sheet.close();
  if (action === 'health-demo') {
    saveHealth(setSnapshot(state, {steps:6842, weightKg:64.2, workoutMinutes:75, workoutCount:2, sleepMinutes:437}, 'demo'));
    sheet.close();
  }
});
render();
let lastNativeRefresh = 0;
async function refreshFromNative() {
  if (!window.AlongHealthBridge?.refresh || document.visibilityState === 'hidden' || Date.now() - lastNativeRefresh < 15_000) return;
  lastNativeRefresh = Date.now();
  try {
    const snapshot = await window.AlongHealthBridge.refresh();
    window.dispatchEvent(new CustomEvent('along-health-update', {detail:snapshot}));
  } catch {
    // No prior HealthKit selection is normal before the first connection.
  }
}
void refreshFromNative();
window.addEventListener('pageshow', () => void refreshFromNative());
window.addEventListener('focus', () => void refreshFromNative());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshFromNative(); });
setInterval(() => { if (document.visibilityState === 'visible') void refreshFromNative(); }, 60_000);
setInterval(() => {
  if (screen!=='task' || document.visibilityState==='hidden') return;
  const task=selectedTask();
  if (!task) return;
  const key=runKey(task.id);
  const run=safeSuperAgentRun(superAgentRuns[key]);
  if (!run || run.status==='done') return;
  superAgentRuns={...superAgentRuns,[key]:advanceSuperAgentRun(run)};
  saveSuperAgentRuns();
  render();
},8_000);
