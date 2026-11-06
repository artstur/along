import {KEY, loadState, setSnapshot} from './health.mjs';
import {ACTIVE_GOAL_KEY, FINANCE_KEY, ensureHealthGoal, loadFinance, connectFinanceDemo, addFinanceDemoRecord, healthView, financeView} from './workspace.mjs';
import {EXPERIMENT, startExperiment, routeHealthEvent, acceptAgentSuggestion, agentRequestPayload} from './loop.mjs';
import {routeHealthChange} from './goal-agent-core.mjs';
import {AGENT_KEY, GOALS_KEY, CONVERSATIONS_KEY, readStored, agentCall, loadNativeConnection, saveNativeConnection} from './agent-client.mjs';
import {ADAPTIVE_LAYOUTS_KEY, customGoalEntries, findInitialCustomGoalCandidate, goalDomain, isCustomGoalKey, safeAdaptiveLayout, validateAdaptiveLayout} from './adaptive-ui.mjs';
import {GOAL_SUPER_AGENT_RUNS_KEY, SUPER_AGENT_RUNS_KEY, createFailedGoalSuperAgentRun, createFailedSuperAgentRun,
  createGoalSuperAgentRequest, createPendingGoalSuperAgentRun, createPendingSuperAgentRun, createSuperAgentRequest,
  safeGoalSuperAgentRun, safeSuperAgentRun, AGENT_RUNTIME_KEY, DSH_RUNTIME, KIMI_RUNTIME, agentRuntimeLabel, safeAgentRuntime} from './super-agent.mjs';
const TICKET_KEY = 'along.goal-ticket.v1';

const app = document.querySelector('#app');
const sheet = document.querySelector('#sheet');
const toast = document.querySelector('#toast');
let state = ensureHealthGoal(loadState(localStorage.getItem(KEY)));
let finance = loadFinance(localStorage.getItem(FINANCE_KEY));
const storedActiveGoal=localStorage.getItem(ACTIVE_GOAL_KEY);
let activeGoal = storedActiveGoal === 'finance' || isCustomGoalKey(storedActiveGoal) ? storedActiveGoal : 'health';
let screen = 'home';
let previousGoalBeforeDraft = null;
let selectedTaskId = null;
let running = false;
let agentBusy = false;
let agentConfig = readStored(AGENT_KEY, {});
let agentRuntime = safeAgentRuntime(localStorage.getItem(AGENT_RUNTIME_KEY) || KIMI_RUNTIME);
let agentConnection = {status:agentConfig.token?'checking':'unconfigured',error:''};
let goalCustom = readStored(GOALS_KEY, {health:null, finance:null, custom:null});
let conversations = readStored(CONVERSATIONS_KEY, {health:[], finance:[], custom:[]});
const storedLayouts = readStored(ADAPTIVE_LAYOUTS_KEY, {health:null, finance:null, custom:null});
let goalLayouts = Object.fromEntries(Object.entries(storedLayouts).map(([key,value])=>[key,safeAdaptiveLayout(value,goalDomain(key))]));
goalLayouts={health:goalLayouts.health||null,finance:goalLayouts.finance||null,...goalLayouts};
let pendingTask = readStored(TICKET_KEY, null);
let superAgentRuns = readStored(SUPER_AGENT_RUNS_KEY, {});
let goalSuperAgentRuns = readStored(GOAL_SUPER_AGENT_RUNS_KEY, {});
function syncAgentViewportHeight() {
  const height=window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--agent-viewport-height',`${Math.round(height)}px`);
}
syncAgentViewportHeight();
window.visualViewport?.addEventListener('resize',syncAgentViewportHeight);
window.addEventListener('resize',syncAgentViewportHeight);
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
async function refreshAgentConnection() {
  if (!agentConfig.token) {agentConnection={status:'unconfigured',error:''};return;}
  agentConnection={status:'checking',error:''};
  if (screen==='agent') renderAgentUpdate();
  try {
    const status=await agentCall(agentConfig,'/connection/status',{runtime:agentRuntime});
    if (!status?.along || !status?.ready || status.runtime!==agentRuntime) throw Error(`${agentRuntimeLabel(agentRuntime)} 尚未就绪`);
    agentConnection={status:'ready',error:''};
    const failedRun=currentGoalSuperAgentRun(activeGoal);
    if (failedRun?.status==='blocked' && failedRun.actual!==true) {
      const key=goalRunKey(activeGoal);
      const {[key]:_discarded,...remainingRuns}=goalSuperAgentRuns;
      goalSuperAgentRuns=remainingRuns;
      saveGoalSuperAgentRuns();
    }
    const history=conversations[activeGoal]||[];
    const cleaned=history.filter(item=>!(item.role==='assistant' && /^这次没有完成：目标输入已迁移到 DSH Super Agent/.test(item.text)));
    if (cleaned.length!==history.length) {
      conversations[activeGoal]=cleaned;
      saveConversations();
    }
  } catch(error) {
    agentConnection={status:'error',error:error.message||'连接检查失败'};
  }
  if (screen==='agent') renderAgentUpdate();
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
  return `<div class="brand"><img class="brand-symbol" src="./app-icon.png" alt=""><span>along</span></div>`;
}
function backButton(action,label) {
  return `<button class="back-button icon-only" data-action="${esc(action)}" aria-label="${esc(label)}" title="${esc(label)}"><svg viewBox="0 0 12 24" aria-hidden="true"><path d="M9 18l-6-6 6-6"/></svg></button>`;
}
function customView(goalKey=activeGoal) {
  return {
    id:'custom',category:'个人目标',title:goalCustom[goalKey]?.title || '定义一个真正属于你的目标',measure:'—',measureUnit:'',percent:0,
    progressText:'先把想实现的改变告诉 Along',note:'Along 会整理目标、待确认信息和动态任务；采用后才更新首页。',
    primary:{title:'从一句话开始',detail:'可以包含期限、偏好、限制、已知条件和你不希望发生的事情。',status:'待定义'},secondary:[],connection:null,
  };
}
const taskStateLabel={temporary:'进行中',planned:'已规划',deferred:'到时生成'};
const agentStateLabel={queued:'等待',working:'工作中',done:'已完成',blocked:'需处理'};
function runtimeMeta(runtime=agentRuntime) {
  return safeAgentRuntime(runtime)===KIMI_RUNTIME
    ? {short:'Kimi Swarm',full:'Kimi Code Agent Swarm',main:'Kimi Main Session',worker:'Subagents',description:'Main Session 启动真实 Swarm，并行子 Agent 拆解、复核并生成动态任务。'}
    : {short:'DSH Agents',full:'DSH Super Agent',main:'DSH Main Session',worker:'Worker',description:'Main Session 接单，Worker 与真实子 Agent 拆解、分工并生成动态任务。'};
}
function currentTaskRecords() {
  const layout=goalLayouts[activeGoal];
  if (layout) return layout.tasks;
  const model=activeGoal==='finance'?financeView(finance,goalCustom.finance):isCustomGoalKey(activeGoal)?customView(activeGoal):healthView(state,goalCustom.health);
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
function runKey(taskId,runtime=agentRuntime) { return `${activeGoal}:${runtime}:${taskId}`; }
function selectedTask() { return currentTaskRecords().find(task=>task.id===selectedTaskId) || null; }
const superAgentRequests=new Set();
function taskRequest(task) { return {...createSuperAgentRequest({task,domain:goalDomain(activeGoal),goal:currentGoal(),context:currentSummary()}),runtime:agentRuntime}; }
function currentSuperAgentRun(task) {
  const key=runKey(task.id);
  const saved=safeSuperAgentRun(superAgentRuns[key]) || (agentRuntime===DSH_RUNTIME?safeSuperAgentRun(superAgentRuns[`${activeGoal}:${task.id}`]):null);
  if (saved) return saved;
  const created=createPendingSuperAgentRun(taskRequest(task),Date.now(),agentRuntime);
  superAgentRuns={...superAgentRuns,[key]:created};
  saveSuperAgentRuns();
  return created;
}
async function submitSuperAgentTask(task) {
  const request=taskRequest(task),key=runKey(task.id);
  if (superAgentRequests.has(request.requestId)) return;
  superAgentRequests.add(request.requestId);
  try {
    if (!agentConfig.token) throw Error('请先在“编辑目标”中连接这台 Mac');
    const response=await agentCall(agentConfig,'/super-agent/tasks',request);
    if (!response?.run?.actual) throw Error(`${agentRuntimeLabel(agentRuntime)} 没有返回真实运行记录`);
    superAgentRuns={...superAgentRuns,[key]:response.run};
  } catch(error) { superAgentRuns={...superAgentRuns,[key]:createFailedSuperAgentRun(request,error.message,Date.now(),agentRuntime)}; }
  finally { superAgentRequests.delete(request.requestId);saveSuperAgentRuns();if (screen==='task'&&selectedTaskId===task.id) render(); }
}
async function refreshSuperAgentTask(task) {
  const request=taskRequest(task),key=runKey(task.id);
  if (!agentConfig.token || superAgentRequests.has(request.requestId)) return;
  superAgentRequests.add(request.requestId);
  try {
    const run=await agentCall(agentConfig,'/super-agent/tasks/status',{requestId:request.requestId,runtime:agentRuntime});
    if (run?.actual) {superAgentRuns={...superAgentRuns,[key]:run};saveSuperAgentRuns();if (screen==='task'&&selectedTaskId===task.id) render();}
  } catch(error) {
    const current=safeSuperAgentRun(superAgentRuns[key]);
    if (!current?.actual) {superAgentRuns={...superAgentRuns,[key]:createFailedSuperAgentRun(request,error.message,Date.now(),agentRuntime)};saveSuperAgentRuns();render();}
  } finally { superAgentRequests.delete(request.requestId); }
}
function saveGoalSuperAgentRuns() { localStorage.setItem(GOAL_SUPER_AGENT_RUNS_KEY,JSON.stringify(goalSuperAgentRuns)); }
function goalRunKey(goalKey=activeGoal,runtime=agentRuntime) { return `${goalKey}:${runtime}`; }
function currentGoalSuperAgentRun(goalKey=activeGoal) {
  return safeGoalSuperAgentRun(goalSuperAgentRuns[goalRunKey(goalKey)]) || (agentRuntime===DSH_RUNTIME?safeGoalSuperAgentRun(goalSuperAgentRuns[goalKey]):null);
}
const goalSuperAgentRequests=new Set();
function saveGoalRun(goalKey,run) {
  goalSuperAgentRuns={...goalSuperAgentRuns,[goalRunKey(goalKey,run?.runtime||agentRuntime)]:run};
  saveGoalSuperAgentRuns();
}
function applyGoalRun(goalKey,value) {
  let run=safeGoalSuperAgentRun(value);
  if (!run) throw Error(`${agentRuntimeLabel(agentRuntime)} 没有返回真实目标编排记录`);
  if (run.status==='done' && run.result && !run.applied) {
    const history=conversations[goalKey]||[];
    if (!history.some(item=>item.requestId===run.requestId)) {
      conversations[goalKey]=[...history,{role:'assistant',text:run.result.reply,proposal:run.result.proposal,layout:run.result.layout,
        requestId:run.requestId}].slice(-20);
      const candidate=goalDomain(goalKey)==='custom'
        ? findInitialCustomGoalCandidate(conversations[goalKey],goalCustom[goalKey],goalLayouts[goalKey])
        : null;
      if (candidate?.index===conversations[goalKey].length-1) {
        applyGeneratedGoal(goalKey,candidate.item);
        conversations[goalKey][candidate.index]={...candidate.item,proposal:null,layout:null};
        activeGoal=goalKey;
        localStorage.setItem(ACTIVE_GOAL_KEY,activeGoal);
        previousGoalBeforeDraft=null;
        if (screen==='agent') screen='home';
        notice('新目标和动态任务已创建');
      }
      saveConversations();
    }
    run={...run,applied:true};
  }
  saveGoalRun(goalKey,run);
  return run;
}
async function submitSuperAgentGoal(goalKey,message,history) {
  const request={...createGoalSuperAgentRequest({domain:goalDomain(goalKey),goal:currentGoal(),snapshot:currentSummary(),message,history}),runtime:agentRuntime};
  saveGoalRun(goalKey,createPendingGoalSuperAgentRun(request,Date.now(),agentRuntime));
  goalSuperAgentRequests.add(request.requestId);
  try {
    const response=await agentCall(agentConfig,'/super-agent/goals',request);
    if (!response?.run?.actual) throw Error(`${agentRuntimeLabel(agentRuntime)} 没有返回真实目标编排记录`);
    applyGoalRun(goalKey,response.run);
  } catch(error) {
    saveGoalRun(goalKey,createFailedGoalSuperAgentRun(request,error.message,Date.now(),request.runtime));
    throw error;
  } finally { goalSuperAgentRequests.delete(request.requestId); }
}
async function refreshSuperAgentGoal(goalKey=activeGoal) {
  const current=currentGoalSuperAgentRun(goalKey);
  if (!current?.actual || current.status!=='working' || goalSuperAgentRequests.has(current.requestId) || !agentConfig.token) return;
  goalSuperAgentRequests.add(current.requestId);
  try {
    const run=await agentCall(agentConfig,'/super-agent/goals/status',{requestId:current.requestId,runtime:current.runtime});
    applyGoalRun(goalKey,run);
    if (screen==='agent'&&activeGoal===goalKey) renderAgentUpdate();
    else if (screen==='home'&&activeGoal===goalKey) render();
  } catch(error) {
    if (!current.actual) saveGoalRun(goalKey,{...current,status:'blocked',statusLabel:`${agentRuntimeLabel(current.runtime)} 状态读取失败`,error:error.message});
  } finally { goalSuperAgentRequests.delete(current.requestId); }
}
function trustedMetric(source) {
  if (activeGoal==='finance') return source==='saved' && finance.connected ? finance.saved : null;
  if (isCustomGoalKey(activeGoal)) return null;
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
  return `<div class="adaptive-module adaptive-metric"><span class="module-title">${esc(module.title)}</span><div class="metric-value"><strong>${value==null?'—':esc(value)}</strong><span>/ ${esc(module.target)} ${esc(module.unit)}</span></div>${numericTarget?`<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>`:''}</div>`;
}
function adaptiveGoalCard(layout) {
  const context=layout.modules.find(module=>module.kind==='chips') || layout.modules.find(module=>module.kind==='fact_list') || layout.modules.find(module=>module.kind==='summary');
  const metric=layout.modules.find(module=>module.kind==='metric');
  const visible=[context,metric].filter(Boolean),visibleIds=new Set(visible.map(module=>module.id));
  const more=layout.modules.filter(module=>!visibleIds.has(module.id));
  return `<section class="goal-card adaptive-goal" aria-label="Along 生成的目标空间"><h1>${esc(layout.title)}</h1><p class="adaptive-summary">${esc(layout.summary)}</p>${visible.map(module=>adaptiveModule(module,true)).join('')}${more.length?`<details class="adaptive-more"><summary>查看目标详情 · ${more.length} 个模块</summary>${more.map(module=>adaptiveModule(module,false)).join('')}</details>`:''}<div class="card-actions"><button class="agent-action" data-action="edit-goal">编辑目标</button></div></section>`;
}
function adaptiveTaskSection(layout) {
  const visible=layout.tasks.slice(0,2),hidden=Math.max(0,layout.tasks.length-visible.length);
  return `<section class="task-section adaptive-tasks" aria-label="动态任务"><div class="section-heading"><h2>动态任务</h2><span>Along 根据目标与情境生成</span></div><div class="adaptive-task-card"><div class="generated-status">${layout.tasks.length} 项已生成 · 点击任务查看协作</div>${visible.map(task=>`<button class="generated-task generated-task-button" data-action="open-task" data-task-id="${esc(task.id)}"><div class="task-meta"><span>${esc(task.when)}</span><span class="state-pill">${esc(taskStateLabel[task.state])}</span></div><strong>${esc(task.title)}</strong><p>${esc(task.detail)}</p><span class="task-open-hint">查看任务协作</span></button>`).join('')}${hidden?`<p class="hidden-count">还有 ${hidden} 项未来触发任务，将在相关时间出现。</p>`:''}${layout.questions.length?`<div class="missing-strip">待确认 ${layout.questions.length} 项：${esc(layout.questions[0])}</div>`:''}<div class="card-actions"><button class="agent-action" data-action="edit-goal">补充信息</button></div></div></section>`;
}
function adaptiveConnectionSection(layout) {
  if (!layout.connections?.length) return '';
  return `<section class="connection-section" aria-label="Along 推荐的连接"><div class="section-heading"><h2>连接</h2><span>在规划中发现的可用能力</span></div>${layout.connections.map(connection=>`<div class="connection-card"><div class="connection-symbol" aria-hidden="true">${connection.id==='duolingo'?'D':'·'}</div><div class="connection-copy"><div class="connection-name"><strong>${esc(connection.name)}</strong><span class="source-tag">${connection.status==='recommended'?'推荐连接':'待确认'}</span></div><p>${esc(connection.reason)}</p></div><button class="agent-action connection-agent-action" data-action="connection-detail" data-connection-id="${esc(connection.id)}">查看</button></div>`).join('')}</section>`;
}
function goalListTitle(title) {
  return /(日语|Japanese|N5|五十音)/i.test(title)?'日语学习':title;
}
function home() {
  const model = activeGoal === 'finance' ? financeView(finance, goalCustom.finance) : isCustomGoalKey(activeGoal) ? customView(activeGoal) : healthView(state, goalCustom.health);
  const layout=goalLayouts[activeGoal];
  const customOptions=customGoalEntries(goalCustom,goalLayouts)
    .map(item=>`<option value="${esc(item.key)}" ${activeGoal===item.key?'selected':''}>${esc(goalListTitle(item.title))}</option>`)
    .join('');
  const connection = model.connection;
  const sourceTime = activeGoal === 'health' && state.snapshot?.updatedAt && state.source === 'healthkit'
    ? ` · ${formatDate(state.snapshot.updatedAt)} 已检查` : '';
  const goalContent=layout?adaptiveGoalCard(layout):`<section class="goal-card" aria-label="${esc(model.category)}">
        <div class="goal-card-top"><span class="eyebrow">${esc(model.category)}</span></div>
        <h1>${esc(model.title)}</h1>
        <div class="goal-numbers"><strong>${esc(model.measure)}</strong><span>${esc(model.measureUnit)}</span></div>
        <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${model.percent}" aria-label="目标进度"><span style="width:${model.percent}%"></span></div>
        <p class="progress-caption">${esc(model.progressText)}</p>
        <p class="goal-note">${esc(model.note)}</p>
        <div class="card-actions"><button class="agent-action" data-action="edit-goal">编辑目标</button></div>
      </section>`;
  const taskContent=layout?adaptiveTaskSection(layout):`<section class="task-section" aria-label="动态任务">
        <div class="section-heading"><h2>动态任务</h2><span>随目标与数据更新</span></div>
        <div class="focus-task"><div class="focus-top"><span>下一步</span><span class="task-chip">${esc(model.primary.status)}</span></div><h3>${esc(model.primary.title)}</h3><p>${esc(model.primary.detail)}</p><div class="card-actions"><button class="agent-action" data-action="edit-goal">补充信息</button></div></div>
        ${pendingTask && activeGoal === 'health' ? `<div class="task-proposal"><span>Apple Health 变化 → 路由判断 → ${pendingTask.suggestion?'Along 提案 → 等待你确认':'等待 Along'}</span><p>${esc(pendingTask.reason)}</p>${pendingTask.suggestion ? `<strong>${esc(pendingTask.suggestion.task)}</strong><p>${esc(pendingTask.suggestion.reason)}</p><button class="button" data-action="accept-task">采用这一步</button> <button class="button secondary" data-action="dismiss-task">保留原任务</button>` : `<p>${esc(pendingTask.error || 'Along 正在规划下一步…')}</p>`}</div>` : ''}
        ${model.secondary.length ? `<div class="task-list">${model.secondary.map((task,index) => `<button class="task-row task-row-button" data-action="open-task" data-task-id="follow-up-${index}"><span class="task-row-mark" aria-hidden="true"></span><div><strong>${esc(task.title)}</strong><p>${esc(task.detail)}</p></div><span class="task-row-status">${esc(task.status)}</span></button>`).join('')}</div>` : ''}
      </section>`;
  const connectionContent=connection?`<section class="connection-section" aria-label="连接来源">
        <div class="section-heading"><h2>连接</h2><span>连接和任务相关的数据源</span></div>
        <div class="connection-card"><div class="connection-symbol" aria-hidden="true">${activeGoal === 'health' ? '♥' : '¥'}</div><div class="connection-copy"><div class="connection-name"><strong>${esc(connection.name)}</strong><span class="source-tag ${connection.kind}">${esc(connection.label)}</span></div><p>${esc(connection.detail)}${esc(sourceTime)}</p></div><button class="agent-action connection-agent-action" data-action="${activeGoal === 'health' ? 'connect-health' : connection.kind === 'demo' ? 'finance-event' : 'connect-finance'}">${esc(connection.action)}</button></div>
        ${connection.metrics?.length ? `<div class="connection-metrics">${connection.metrics.map(item=>`<div><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong></div>`).join('')}</div>` : ''}
        ${state.source === 'demo' && activeGoal === 'health' ? '<button class="minor-action" data-action="clear-health-demo">退出健康演示数据</button>' : ''}
        ${activeGoal === 'finance' && finance.connected ? '<p class="connection-footnote">点“模拟 +¥800”只会更新这份本机演示数据，不会访问账户或发起交易。</p>' : ''}
      </section>`:'';
  const recommendedConnectionContent=layout?adaptiveConnectionSection(layout):'';
  return `<div class="app-shell"><header class="topbar"><div class="topbar-inner">${brand()}</div></header>
    <main class="content ${layout?'adaptive-space':''}">
      <div class="goal-switch"><label for="goal-select">当前目标</label><div class="goal-switch-actions"><div class="select-wrap"><select id="goal-select" aria-label="切换目标"><option value="health" ${activeGoal === 'health' ? 'selected' : ''}>健康 · ${goalLayouts.health?'个性化计划':'每周运动'}</option><option value="finance" ${activeGoal === 'finance' ? 'selected' : ''}>理财 · ${goalLayouts.finance?'个性化计划':'应急储备'}</option>${customOptions}<option value="new-custom">＋ 新建目标</option></select><span aria-hidden="true">⌄</span></div><button class="goal-add-button" data-action="new-goal">新建</button></div></div>
      <div class="runtime-switch home-runtime-switch" role="group" aria-label="选择 Agent 运行时"><button type="button" data-action="select-runtime" data-runtime="${DSH_RUNTIME}" class="${agentRuntime===DSH_RUNTIME?'active':''}" aria-pressed="${agentRuntime===DSH_RUNTIME}">DSH Agents</button><button type="button" data-action="select-runtime" data-runtime="${KIMI_RUNTIME}" class="${agentRuntime===KIMI_RUNTIME?'active':''}" aria-pressed="${agentRuntime===KIMI_RUNTIME}">Kimi Swarm</button></div>
      ${goalContent}
      ${taskContent}
      ${connectionContent}
      ${recommendedConnectionContent}
    </main><footer>Along · 一起，慢慢向前</footer></div>`;
}

function taskAgentCard(agent) {
  const progress=Number.isFinite(agent.progress)?agent.progress:agent.status==='done'?100:agent.status==='working'?55:agent.status==='blocked'?85:0;
  return `<article class="worker-card ${agent.status}"><div class="worker-card-head"><span class="worker-mark" aria-hidden="true">A</span><div><strong>Along</strong><span>协作单元</span></div><span class="worker-state">${esc(agentStateLabel[agent.status]||agent.status)}</span></div><p class="worker-objective">${esc(agent.objective)}</p><div class="worker-progress"><span style="width:${progress}%"></span></div><p class="worker-now"><span>当前</span>${esc(agent.work)}</p>${agent.report?`<p class="worker-output"><span>报告</span>${esc(agent.report.summary)}</p>`:''}</article>`;
}
function taskDetailPage() {
  const task=selectedTask();
  if (!task) {
    return `<div class="app-shell"><header class="topbar"><div class="topbar-inner">${brand()}<span class="topbar-caption">Along</span></div></header><main class="content task-detail">${backButton('task-back','返回动态任务')}<div class="empty-task"><h1>任务已更新</h1><p>这项动态任务已不在当前计划中，请返回查看最新安排。</p></div></main></div>`;
  }
  const run=currentSuperAgentRun(task);
  const meta=runtimeMeta(run.runtime);
  const evalText=run.eval?.decision==='accept'?'接受执行':run.eval?.decision==='evaluating'?'正在评估':run.eval?.decision==='ignore'?'未接受':run.eval?.decision||'等待评估';
  const workers=[{name:meta.main,role:'Orchestrator',status:run.eval?.decision==='evaluating'?'working':run.eval?'done':'queued',objective:'评估任务、建立授权边界并编排并行工作。',work:run.eval?`Eval：${evalText}`:'等待接收 Trigger',report:null},...run.assignments];
  const mandateText=run.mandate?`${run.mandate.strength==='explicit'?'明确授权':'推断授权'} · 请求者 ${run.mandate.actor?.id||'—'} · Policy ${run.mandate.policyVersion?.slice(0,8)||'—'}`:'尚未生成 Mandate';
  return `<div class="app-shell super-agent-shell"><header class="topbar"><div class="topbar-inner">${brand()}<span class="topbar-caption">Along · 任务协作</span></div></header><main class="content task-detail">
    ${backButton('task-back','返回动态任务')}
    <section class="task-hero"><div class="task-hero-top"><span class="eyebrow">${esc(task.when)} · ${esc(taskStateLabel[task.state])}</span><span class="run-status ${run.status}"><i></i>${esc(run.statusLabel)}</span></div><h1>${esc(task.title)}</h1><p>${esc(task.detail)}</p><div class="run-progress-head"><span>总体进展</span><strong>${run.progress}%</strong></div><div class="run-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${run.progress}"><span style="width:${run.progress}%"></span></div></section>

    <section class="orchestration-section"><div class="section-heading"><h2>编排链路</h2><span>${run.runtime===KIMI_RUNTIME?'Kimi Session 到并行 Subagents':'从触发到可交付 Ticket'}</span></div><div class="orchestration-flow">
      <div><span>Source</span><strong>${esc(run.source.label)}</strong></div><b aria-hidden="true">→</b>
      <div><span>Trigger</span><strong>${esc(run.trigger.label)}</strong></div><b aria-hidden="true">→</b>
      <div><span>Eval</span><strong>${esc(evalText)}</strong></div><b aria-hidden="true">→</b>
      <div><span>Ticket</span><strong>${esc(run.ticket?.id||'尚未创建')}</strong></div>
    </div><div class="mandate-card"><span>Mandate · 本次授权边界</span><p>${esc(mandateText)}</p></div></section>

    <section class="workers-section"><div class="section-heading"><h2>真实分工</h2><span>${workers.filter(agent=>agent.status==='done').length} / ${workers.length} 已完成</span></div><div class="worker-grid">${workers.map(taskAgentCard).join('')}</div></section>

    <section class="activity-section"><div class="section-heading"><h2>工作记录</h2><span>只记录有意义的状态变化</span></div><div class="activity-list">${run.events.map((event,index)=>`<div class="activity-row"><span class="activity-dot ${index===run.events.length-1&&run.status!=='done'?'active':''}"></span><div><strong>${esc(event.text)}</strong><span>${formatTime(event.at)}</span></div></div>`).join('')}</div></section>

    <aside class="architecture-note"><strong>${run.actual?`真实 ${meta.full} 运行`:'等待真实运行'}</strong><p>${esc(run.error||`以上状态来自本机 ${meta.full} 的真实会话与子 Agent；没有用定时动画模拟。`)}</p></aside>
  </main></div>`;
}

function goalOrchestrationPanel(run) {
  if (!run) return '';
  const meta=runtimeMeta(run.runtime);
  const events=(run.events||[]).slice(-5);
  const mandateText=typeof run.mandate==='string'?run.mandate:run.mandate?.scope||'仅围绕本次目标进行拆解、规划与可交付执行。';
  return `<section class="goal-orchestration ${run.status}" aria-live="polite"><div class="goal-run-head"><div><span class="eyebrow">真实 ${esc(meta.full)}</span><h2>${esc(run.statusLabel)}</h2></div><strong>${run.progress}%</strong></div><div class="run-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${run.progress}"><span style="width:${run.progress}%"></span></div>
  <div class="orchestration-flow compact"><div><span>Source</span><strong>目标输入</strong></div><b aria-hidden="true">→</b><div><span>${run.runtime===KIMI_RUNTIME?'Session':'Main Session'}</span><strong>${run.eval?.decision==='accept'?'已接单':run.eval?.decision==='evaluating'?'评估中':'等待'}</strong></div><b aria-hidden="true">→</b><div><span>${run.runtime===KIMI_RUNTIME?'Swarm':'Ticket'}</span><strong>${run.runtime===KIMI_RUNTIME?'已开启':run.ticket?esc(run.ticket.id.slice(0,8)):'创建中'}</strong></div><b aria-hidden="true">→</b><div><span>${esc(meta.worker)}</span><strong>${run.agents?.length||0} 个 Agent</strong></div></div>
  ${run.mandate?`<div class="mandate-card"><span>Mandate · 本次授权边界</span><p>${esc(mandateText)}</p></div>`:''}
  ${run.agents?.length?`<div class="worker-grid">${run.agents.map(taskAgentCard).join('')}</div>`:''}
  ${events.length?`<div class="goal-run-events">${events.map(event=>`<p><span>${formatTime(event.at)}</span>${esc(event.text)}</p>`).join('')}</div>`:''}
  ${run.error?`<p class="goal-run-error">${esc(run.error)}</p>`:''}</section>`;
}

function agentPreview(item,index,goal,domain) {
  if (!item.proposal && !item.layout) return '';
  const change=domain==='health'?`${goal.target} → ${item.proposal?.target} 分钟 / 周`:domain==='finance'?`¥${goal.target.toLocaleString('zh-CN')} → ¥${item.proposal?.target.toLocaleString('zh-CN')}`:'建立新的自定义目标';
  const goalChange=item.proposal?`<span>目标变化：${change}</span><strong>${esc(item.proposal.title)}</strong><p>下一步：${esc(item.proposal.task)}</p><p>${esc(item.proposal.reason)}</p>`:'';
  const layoutPreview=item.layout?`<span>Along 生成的目标空间</span><strong>${esc(item.layout.title)}</strong><p>${esc(item.layout.summary)}</p><p>${item.layout.modules.length} 个目标模块 · ${item.layout.tasks.length} 项动态任务 · ${item.layout.questions.length} 项待确认</p>`:'';
  return `<div class="proposal-preview">${goalChange}${layoutPreview}<button class="button" data-action="accept-goal" data-index="${index}">${item.proposal?'确认采用目标与界面':'采用这个目标空间'}</button></div>`;
}
function agentMessage(item,index,goal,domain) {
  return `<div class="agent-message ${item.role}"><p>${esc(item.text)}</p>${agentPreview(item,index,goal,domain)}</div>`;
}
function agentPending(id) {
  return `<div class="agent-message assistant pending" data-agent-run="${esc(id)}" role="status"><div class="agent-thinking"><span aria-hidden="true"><i></i><i></i><i></i></span><p>正在连接 ${esc(runtimeMeta().full)}…</p></div></div>`;
}
function setAgentComposerBusy(busy) {
  const form=app.querySelector('#agent-form');
  const button=form?.querySelector('.agent-send');
  if (form) form.setAttribute('aria-busy',String(busy));
  if (button) button.disabled=busy || !agentConfig.token;
}
function scrollAgentConversationToBottom() {
  requestAnimationFrame(()=>{
    const scroller=app.querySelector('.agent-scroll');
    scroller?.scrollTo({top:scroller.scrollHeight,behavior:'smooth'});
  });
}
function goalAgentPage() {
  const goalKey=activeGoal;
  const domain=goalDomain(goalKey);
  const goal=currentGoal();
  const history=conversations[goalKey] || [];
  const goalRun=currentGoalSuperAgentRun(goalKey);
  const goalRunning=goalRun?.status==='working';
  const meta=runtimeMeta();
  const label=domain==='health'?'健康':domain==='finance'?'理财演示':goalCustom[goalKey]?.title?goalListTitle(goalCustom[goalKey].title):'新建目标';
  const targetText=domain==='health'?`${goal.target} 分钟 / 周`:domain==='finance'?`¥${goal.target.toLocaleString('zh-CN')}`:'由你用自然语言定义';
  const connectionText=agentConnection.status==='ready'?[`Along 与 ${meta.short} 已连接`,'整条目标编排链路可用','已验证']:
    agentConnection.status==='error'?['连接需处理',agentConnection.error,'需处理']:['正在检查连接',`正在验证 Mac Host 与 ${meta.full}`,'检查中'];
  return `<div class="app-shell agent-shell"><header class="topbar"><div class="topbar-inner">${brand()}</div></header><main class="content agent-page"><div class="agent-scroll">${backButton('agent-back','返回目标')}<div class="agent-title"><span class="eyebrow">${label} · ${esc(meta.full)}</span><h1>${esc(goal.title)}</h1><p>当前目标：${targetText}。${esc(meta.description)}确认后才会改变首页。</p></div>
  <div class="runtime-switch" role="group" aria-label="选择 Agent 运行时"><button type="button" data-action="select-runtime" data-runtime="${DSH_RUNTIME}" class="${agentRuntime===DSH_RUNTIME?'active':''}" aria-pressed="${agentRuntime===DSH_RUNTIME}">DSH Agents</button><button type="button" data-action="select-runtime" data-runtime="${KIMI_RUNTIME}" class="${agentRuntime===KIMI_RUNTIME?'active':''}" aria-pressed="${agentRuntime===KIMI_RUNTIME}">Kimi Swarm</button></div>
  ${agentConfig.token ? `<div class="agent-status ${agentConnection.status}"><strong>${esc(connectionText[0])}</strong><span>${esc(connectionText[1])}</span><em>${esc(connectionText[2])}</em></div>` : `<div class="agent-setup"><h2>首次连接 Along</h2><p>只需设置一次，之后会自动恢复。让 Mac 与 iPhone 保持在同一网络，启动 Along 服务后填入一次连接信息。</p><form id="pair-form"><input name="baseURL" placeholder="Along 服务地址" value="${esc(agentConfig.baseURL||'')}" required><input name="fingerprint" placeholder="连接指纹" value="${esc(agentConfig.fingerprint||'')}" required><input name="code" placeholder="一次性连接码" inputmode="numeric" required><button class="button" ${agentBusy?'disabled':''}>${agentBusy?'连接中…':'连接 Along'}</button></form></div>`}
  <div class="agent-messages" role="log" aria-live="polite">${history.length?history.map((item,index)=>agentMessage(item,index,goal,domain)).join(''):'<p class="agent-empty">说说你希望达成什么、期限、约束和偏好；Along 会先整理并请你确认。</p>'}</div>
  ${goalOrchestrationPanel(goalRun)}
  </div><div class="agent-composer-dock"><form id="agent-form" class="agent-composer" aria-busy="${agentBusy||goalRunning}"><textarea name="message" rows="1" placeholder="描述你的目标" maxlength="800" required ${goalRunning?'disabled':''}></textarea><button class="agent-send" aria-label="交给 Super Agent" title="交给 Super Agent" ${agentBusy||goalRunning||!agentConfig.token?'disabled':''}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m0 0L6.5 8.5M10 5l3.5 3.5"/></svg></button></form><p class="agent-disclaimer">${goalRunning?'Super Agent 编排中…':domain==='finance'?'理财连接和余额仍是演示；Super Agent 只规划，不交易。':domain==='health'?'仅发送当前目标与所选健康摘要，不发送原始记录。':'Along · 一起，慢慢向前'}</p></div></main></div>`;
}

function currentGoal() {
  return activeGoal==='health' ? {domain:'health',title:goalCustom.health?.title || `本周累计运动 ${state.goals.find(item=>item.type==='workout')?.target||120} 分钟`,target:state.goals.find(item=>item.type==='workout')?.target||120} : activeGoal==='finance' ? {domain:'finance',title:goalCustom.finance?.title || '三个月存下 ¥10,000 应急金',target:goalCustom.finance?.target||10000} : {domain:'custom',title:goalCustom[activeGoal]?.title || '定义我的新目标',target:null};
}
function currentSummary() {
  return activeGoal==='health' ? {workoutMinutes:state.snapshot?.workoutMinutes ?? null,selectedTypes:state.source==='healthkit' && state.snapshot?.selectedTypes?.includes('workout')?['workout']:[]} : activeGoal==='finance' ? {saved:finance.connected?finance.saved:null} : {};
}
function saveConversations() { localStorage.setItem(CONVERSATIONS_KEY,JSON.stringify(conversations)); }
function saveGoalCustom() { localStorage.setItem(GOALS_KEY,JSON.stringify(goalCustom)); }
function saveGoalLayouts() { localStorage.setItem(ADAPTIVE_LAYOUTS_KEY,JSON.stringify(goalLayouts)); }
function applyGeneratedGoal(goalKey,item) {
  if (!item?.proposal && !item?.layout) return false;
  const domain=goalDomain(goalKey);
  const validatedLayout=item.layout?validateAdaptiveLayout(item.layout,domain):null;
  if (item.proposal) {
    goalCustom[goalKey]={...item.proposal};
    if (goalKey==='health') saveHealth({...state,goals:state.goals.map(goal=>goal.type==='workout'?{...goal,target:item.proposal.target}:goal)});
  }
  if (validatedLayout) goalLayouts[goalKey]=validatedLayout;
  saveGoalCustom();
  saveGoalLayouts();
  return true;
}
function consumeGoalProposal(goalKey,index) {
  conversations[goalKey]=conversations[goalKey].map((entry,i)=>i===index?{...entry,proposal:null,layout:null}:entry);
  saveConversations();
}
function adoptPendingInitialCustomGoal() {
  const candidate=findInitialCustomGoalCandidate(conversations.custom,goalCustom.custom,goalLayouts.custom);
  if (!candidate) return false;
  try {
    applyGeneratedGoal('custom',candidate.item);
    consumeGoalProposal('custom',candidate.index);
    activeGoal='custom';
    localStorage.setItem(ACTIVE_GOAL_KEY,activeGoal);
    return true;
  } catch { return false; }
}

function experimentPanel() {
  const loop = state.loop?.experiment === EXPERIMENT ? state.loop : null;
  const latest = loop?.changes?.find(item => item.decision === 'replan');
  const quiet = loop?.changes?.filter(item => item.decision === 'quiet').length ?? 0;
  return `<section class="lab-card">${loop ? `<div class="lab-head"><div><strong>本周健身 120 分钟</strong><p>从 75 分钟开始，观察任务何时改变。</p></div><button class="minor-action" data-action="experiment-reset">重新开始</button></div><div class="lab-actions"><button class="button" data-action="event-workout-35" ${running ? 'disabled' : ''}>新增 35 分钟</button><button class="button secondary" data-action="event-workout-1" ${running ? 'disabled' : ''}>仅新增 1 分钟</button><button class="button secondary" data-action="event-steps" ${running ? 'disabled' : ''}>仅步数变化</button></div>${latest ? `<div class="change-card"><span class="eyebrow">${latest.status === 'pending' ? '正在请求 Along…' : latest.status === 'error' ? '建议暂不可用' : latest.source === 'live-along' ? 'Along 实时建议' : 'Along 建议回放'}</span><div class="change-flow"><div><span>原任务</span><strong>${esc(latest.beforeTask)}</strong></div><span class="flow-arrow">→</span><div><span>新任务</span><strong>${esc(latest.suggestion?.task ?? (latest.status === 'error' ? '尚未生成' : '生成中…'))}</strong></div></div><p>${latest.remainingBefore} → ${latest.remainingAfter} 分钟待完成。${esc(latest.reason)} ${esc(latest.suggestion?.reason ?? '')}</p>${latest.status === 'error' ? `<p>${esc(latest.error)}</p>` : ''}${latest.source === 'recorded-along' ? '<p>公网版显示已录制的 Along 运行结果。</p>' : ''}</div>` : '<p class="lab-hint">轻微或无关变化会安静处理；显著变化才请求新任务。</p>'}${quiet ? `<p class="lab-hint">${quiet} 条变化已安静处理，没有调用 Along。</p>` : ''}` : `<div class="lab-head"><div><strong>看一次目标驱动的调整</strong><p>预设本周 120 分钟、已完成 75 分钟。</p></div></div><button class="button lab-start" data-action="experiment-start">开始实验</button>`}</section>`;
}
function lab() {
  return `<div class="app-shell"><header class="topbar"><div class="topbar-inner">${brand()}<span class="topbar-caption">目标变化实验</span></div></header><main class="content lab-content">${backButton('back-home','返回目标')}<h1>当进度变化，下一步会怎样变？</h1><p class="lab-intro">这是与真实健康数据隔离的模拟实验。Along 计算进度，再判断是否需要更新建议。</p>${experimentPanel()}</main></div>`;
}
function render() { app.innerHTML = screen === 'lab' ? lab() : screen === 'agent' ? goalAgentPage() : screen === 'task' ? taskDetailPage() : home(); }
function renderAgentUpdate({follow=false}={}) {
  const previous=app.querySelector('.agent-scroll');
  if (!previous) {render();return;}
  const scrollTop=previous.scrollTop;
  const nearBottom=previous.scrollHeight-previous.scrollTop-previous.clientHeight<160;
  render();
  const next=app.querySelector('.agent-scroll');
  if (!next) return;
  next.scrollTop=follow||nearBottom?next.scrollHeight:Math.min(scrollTop,Math.max(0,next.scrollHeight-next.clientHeight));
}
window.__alongNavigateBack = () => {
  const button=app.querySelector('.back-button[data-action]');
  if (!button) return false;
  button.click();
  return true;
};

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
      result = {decision:'replan', source:'recorded-along', suggestion:replay.suggestion};
    } else if (localAgent) {
      const response = await fetch('./api/health-event', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(agentRequestPayload(before, event))});
      result = await response.json();
      if (!response.ok) throw Error(result.error || 'Along 请求失败');
    } else throw Error('公网演示仅提供 75＋35 分钟场景的 Along 回放');
    if (result.decision !== 'replan') throw Error('服务端没有确认重排');
    const suggestion = acceptAgentSuggestion(JSON.stringify(result.suggestion), route.remainingAfter);
    if (state.loop?.changes?.[0]?.id !== id) return;
    saveHealth({...state, loop:{...state.loop, currentTask:suggestion.task, changes:[{...entry, status:'done', suggestion, source:result.source}, ...state.loop.changes.slice(1)]}});
  } catch (error) {
    if (state.loop?.changes?.[0]?.id === id) saveHealth({...state, loop:{...state.loop, changes:[{...entry, status:'error', error:error.message}, ...state.loop.changes.slice(1)]}});
  } finally { running = false; render(); }
}

function beginNewGoal() {
  previousGoalBeforeDraft=activeGoal;
  activeGoal=`custom:${crypto.randomUUID()}`;
  conversations[activeGoal]=[];
  screen='agent';
  render();
  if (agentConfig.token) void refreshAgentConnection();
}

app.addEventListener('change', event => {
  if (event.target.id !== 'goal-select') return;
  if (event.target.value === 'new-custom') {
    beginNewGoal();
    return;
  }
  activeGoal = event.target.value === 'finance' || isCustomGoalKey(event.target.value) ? event.target.value : 'health';
  localStorage.setItem(ACTIVE_GOAL_KEY, activeGoal);
  render();
});
app.addEventListener('input', event => {
  if (!event.target.matches('#agent-form textarea')) return;
  event.target.style.height='auto';
  event.target.style.height=`${Math.min(event.target.scrollHeight,120)}px`;
});
app.addEventListener('click', event => {
  const actionTarget=event.target.closest('[data-action]');
  const action = actionTarget?.dataset.action;
  if (!action) return;
  if (action === 'connection-detail') {
    const connection=goalLayouts[activeGoal]?.connections?.find(item=>item.id===actionTarget.dataset.connectionId);
    if (!connection) return;
    show(`<div class="sheet-head"><h2>${esc(connection.name)}</h2><button class="icon-button" data-action="close" aria-label="关闭">×</button></div><p class="sheet-copy">${esc(connection.reason)}</p><div class="permission-list"><span>${esc(connection.capability)}</span></div>${connection.id==='duolingo'?'<button class="button sheet-main-button" data-action="open-duolingo">打开 Duolingo</button>':''}<p class="sheet-footnote">当前版本不会冒充账户已连接；学习进度只会在获得 Duolingo 授权后同步。</p>`);
    return;
  }
  if (action === 'new-goal') { beginNewGoal();return; }
  if (action === 'select-runtime') {
    const next=safeAgentRuntime(actionTarget.dataset.runtime);
    if (next===agentRuntime) return;
    agentRuntime=next;
    localStorage.setItem(AGENT_RUNTIME_KEY,agentRuntime);
    agentConnection={status:agentConfig.token?'checking':'unconfigured',error:''};
    renderAgentUpdate();
    if (agentConfig.token) void refreshAgentConnection();
    return;
  }
  if (action === 'open-task') {
    selectedTaskId=actionTarget.dataset.taskId || null;
    if (!selectedTaskId) return;
    screen='task';
    render();
    const task=selectedTask();
    if (task) void submitSuperAgentTask(task);
  }
  if (action === 'task-back') { selectedTaskId=null;screen='home';render(); }
  if (action === 'edit-goal') { screen='agent'; render();if (agentConfig.token) void refreshAgentConnection(); }
  if (action === 'agent-back') {
    if (isCustomGoalKey(activeGoal) && !goalCustom[activeGoal] && !goalLayouts[activeGoal]) {
      delete conversations[activeGoal];
      activeGoal=previousGoalBeforeDraft || 'health';
      previousGoalBeforeDraft=null;
    }
    screen='home';
    render();
  }
  if (action === 'accept-goal') {
    const index=Number(actionTarget.dataset.index),item=conversations[activeGoal]?.[index];
    if (!item?.proposal && !item?.layout) return;
    applyGeneratedGoal(activeGoal,item);
    consumeGoalProposal(activeGoal,index);
    if (isCustomGoalKey(activeGoal)) {
      localStorage.setItem(ACTIVE_GOAL_KEY,activeGoal);
      previousGoalBeforeDraft=null;
    }
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
  if (event.target.id==='agent-form' && currentGoalSuperAgentRun()?.status==='working') return;
  const formElement=event.target;
  const form=new FormData(formElement);
  if (formElement.id==='pair-form') {
    agentBusy=true;
    render();
    try {
      const config={baseURL:String(form.get('baseURL')).trim().replace(/\/$/,''),fingerprint:String(form.get('fingerprint')).trim().replace(/[^a-fA-F0-9]/g,'').toUpperCase()};
      const result=await agentCall(config,'/pair',{code:String(form.get('code')).trim()});
      agentConfig={...config,token:result.token};
      agentConnection={status:'ready',error:''};
      localStorage.setItem(AGENT_KEY,JSON.stringify(agentConfig));
      await saveNativeConnection(agentConfig);
      notice('已连接 Along，之后会自动恢复');
    } catch(error) { notice(error.message || 'Along 请求失败'); }
    finally { agentBusy=false;render(); }
    return;
  }

  const message=String(form.get('message')).trim();
  if (!message) return;
  const goalKey=activeGoal;
  const domain=goalDomain(goalKey);
  const history=conversations[goalKey]||[];
  const goal=currentGoal();
  const userEntry={role:'user',text:message};
  const pendingId=crypto.randomUUID();
  agentBusy=true;
  conversations[goalKey]=[...history,userEntry].slice(-20);
  saveConversations();
  const messages=app.querySelector('.agent-messages');
  messages?.querySelector('.agent-empty')?.remove();
  messages?.insertAdjacentHTML('beforeend',agentMessage(userEntry,conversations[goalKey].length-1,goal,domain));
  messages?.insertAdjacentHTML('beforeend',agentPending(pendingId));
  formElement.querySelector('textarea')?.blur();
  formElement.reset();
  const textarea=formElement.querySelector('textarea');
  if (textarea) textarea.style.height='auto';
  setAgentComposerBusy(true);
  scrollAgentConversationToBottom();
  try {
    await submitSuperAgentGoal(goalKey,message,history.map(item=>({role:item.role,text:item.text})));
  } catch(error) {
    notice(error.message || 'Along 请求失败');
  } finally {
    agentBusy=false;
    if (screen==='agent' && activeGoal===goalKey) {
      renderAgentUpdate({follow:true});
    } else render();
  }
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
  if (!agentConfig.token) { saveTicket({...ticket,status:'waiting',error:'Along 未连接；进度已更新，任务可稍后再规划。'});if (screen==='home') render();return; }
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
  if (action === 'open-duolingo') window.location.href='https://www.duolingo.com/learn';
  if (action === 'health-demo') {
    saveHealth(setSnapshot(state, {steps:6842, weightKg:64.2, workoutMinutes:75, workoutCount:2, sleepMinutes:437}, 'demo'));
    sheet.close();
  }
});
const recoveredInitialCustomGoal=adoptPendingInitialCustomGoal();
if ('scrollRestoration' in history) history.scrollRestoration='manual';
render();
requestAnimationFrame(()=>window.scrollTo({top:0,left:0,behavior:'instant'}));
setTimeout(()=>window.scrollTo({top:0,left:0,behavior:'instant'}),120);
setTimeout(()=>window.scrollTo({top:0,left:0,behavior:'instant'}),420);
if (recoveredInitialCustomGoal) notice('已恢复新目标和动态任务');
async function restoreAlongConnection() {
  if (agentConfig.token) {
    try { await saveNativeConnection(agentConfig); } catch { /* Local storage still keeps the connection. */ }
    void refreshAgentConnection();
    return;
  }
  try {
    const saved=await loadNativeConnection();
    if (!saved?.baseURL || !saved?.fingerprint || !saved?.token) return;
    agentConfig=saved;
    agentConnection={status:'checking',error:''};
    localStorage.setItem(AGENT_KEY,JSON.stringify(agentConfig));
    render();
    void refreshAgentConnection();
  } catch {
    // First launch without a native connection is expected.
  }
}
void restoreAlongConnection();
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
  void refreshSuperAgentTask(task);
},4_000);
setInterval(() => {
  if (screen!=='agent' || document.visibilityState==='hidden') return;
  void refreshSuperAgentGoal(activeGoal);
},3_000);
