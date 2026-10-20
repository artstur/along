import {STORAGE_KEY,createState,loadState,uid,triggerChange,suggest,financePreview,applyProposal,toggleTask,saveSkill,editMemory,activeMemory} from './engine.mjs';

const app=document.getElementById('app'),sheet=document.getElementById('sheet');
let state,storageAvailable=true;
try{state=loadState(localStorage.getItem(STORAGE_KEY));}catch{state=createState();storageAvailable=false;}
let toastTimer,modalKind='',formDraft=null;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>`¥${Number(value).toLocaleString('zh-CN')}`;
const date=value=>value?.replaceAll('-','.');
const paths={
  target:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="m12 12 7-7m-3 0h3v3"/>',
  link:'<path d="m10 13 4-4m-6 6-1.5 1.5a4 4 0 0 1-5.7-5.7L5 7.6a4 4 0 0 1 5.7 0m2.6 8.8a4 4 0 0 0 5.7 0l3.2-3.2a4 4 0 0 0-5.7-5.7L15 9"/>',
  memory:'<path d="M9 18H7a4 4 0 0 1-3-6.7A4 4 0 0 1 8 5a4 4 0 0 1 4-2 4 4 0 0 1 4 2 4 4 0 0 1 4 6.3A4 4 0 0 1 17 18h-2M9 8v12m6-12v12M7 11h2m6 3h2"/>',
  book:'<path d="M12 5v16M3 4h5a4 4 0 0 1 4 3 4 4 0 0 1 4-3h5v15h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3z"/>',
  checkList:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M8 10l1 1 2-2m2 1h3m-8 6 1 1 2-2m2 1h3"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  arrowUp:'<path d="M6 18 18 6M6 6h12v12"/>',
  leaf:'<path d="M19 4c1 9-2 14-8 14-5 0-7-4-5-8S13 5 19 4ZM5 21l9-10"/>',
  wallet:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 8V5a2 2 0 0 1 2-2h12m-1 9h5v5h-5a2.5 2.5 0 0 1 0-5Z"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 2v6m10-6v6M3 11h18m-13 5h2m4 0h2"/>',
  heart:'<path d="M20 5c-3-3-6-1-8 1-2-2-5-4-8-1-5 5 2 11 8 16 6-5 13-11 8-16Z"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  spark:'<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6zM8 12l3 3 5-6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  edit:'<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  reset:'<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  file:'<path d="M14 2H5v20h14V7zM14 2v6h5M8 12h8m-8 4h6"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 0 1 6 1c0 2-3 2-3 5m0 3h.01"/>',
  pause:'<path d="M8 5v14M16 5v14"/>',
  dots:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>'
};
const icon=(name)=>`<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${paths[name]??paths.spark}</svg>`;
const brand=`<svg class="brand-mark" viewBox="0 0 40 44" aria-hidden="true"><path d="M4 36 19 7c.5-1 2-1 2.5 0L37 36M11 25h19" stroke="currentColor" stroke-width="3.2" fill="none" stroke-linecap="round"/><circle cx="33" cy="8" r="3" fill="#c6a467"/></svg>`;
const art=`<div class="change-art" aria-hidden="true"><svg viewBox="0 0 210 210"><ellipse cx="114" cy="183" rx="69" ry="8" fill="#1d3f35"/><path d="M116 179c-11-34-9-71 1-112M116 139c-24-7-39-21-42-44 27 1 39 21 42 44Z" stroke="#cbd5bc" fill="#92a584" stroke-width="1.5"/><path d="M113 111c28-4 46-21 47-47-27 1-46 24-47 47Z" stroke="#cbd5bc" fill="#c3cca8" stroke-width="1.5"/><path d="M117 79c-15-12-22-29-17-48 21 9 27 29 17 48Z" stroke="#cbd5bc" fill="#94a68a" stroke-width="1.5"/><path d="M115 161c24-2 38-15 40-33-22-2-37 12-40 33Z" fill="#9eaf8b" stroke="#cbd5bc" stroke-width="1.5"/><path d="M95 170h42l-6 26h-30z" fill="#c9ae7b"/><circle cx="52" cy="50" r="13" fill="#d2bd8c"/><path d="M49 20v-6m-20 28-5-2m53-7 4-4m-19 46 2 5" stroke="#99ad91" stroke-width="1.5" stroke-linecap="round"/><path d="M40 155c-7-18-6-37 1-54m0 27c-12-4-18-13-18-22 12 1 18 11 18 22Zm-1 15c11-5 16-13 14-23-11 5-15 12-14 23Z" fill="#6f8e73" stroke="#94aa8a" stroke-width="1.2"/></svg></div>`;
const NAV=[['goals','target','目标'],['connections','link','连接应用'],['memory','memory','记忆'],['knowledge','book','知识库'],['tasks','checkList','任务']];

function persist(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));}catch{storageAvailable=false;}}
function commit(next){state=next;persist();render();}
function notify(message){const t=document.getElementById('toast');t.textContent=message;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),3500);}
function go(view){state.view=view;persist();render();window.scrollTo({top:0,behavior:'instant'});}
function render(){
  const pending=state.tasks.filter(t=>t.status==='todo').length;
  const nav=mobile=>NAV.map(([id,i,label])=>`<button class="${mobile?'':'nav-item '}${state.view===id?'active':''}" data-action="nav" data-view="${id}" ${state.view===id?'aria-current="page"':''}>${icon(i)}<span>${label}</span>${!mobile&&id==='tasks'?`<span class="nav-count">${pending}</span>`:''}</button>`).join('');
  const views={goals:goalsView,connections:connectionsView,memory:memoryView,knowledge:knowledgeView,tasks:tasksView};
  app.innerHTML=`<aside class="sidebar"><a href="#goals" data-action="nav" data-view="goals" class="wordmark">${brand}along</a><div class="brand-sub">一起，慢慢向前</div><nav class="side-nav" aria-label="主导航">${nav(false)}</nav><div class="side-foot"><div class="local-label">${icon('shield')}<span>你的节奏，你来决定。<br>数据仅保存在此浏览器</span></div><div class="profile"><span class="avatar">悦</span><div><strong>${esc(state.profile.name)}</strong><small>一个人的长期伙伴</small></div><button class="text-btn" data-action="about" aria-label="关于与数据管理">${icon('dots')}</button></div></div></aside>
  <main class="main"><header class="topbar"><div class="wordmark mobile-only">${brand}along</div><div class="crumb">你的空间 <span style="margin:0 10px;opacity:.4">/</span> ${NAV.find(n=>n[0]===state.view)[2]}</div><div class="top-actions"><span class="demo-label"><i class="dot"></i>交互体验版</span><button class="text-btn small-ico" data-action="guide" aria-label="体验指南">${icon('help')}<span class="desktop-only">体验指南</span></button><button class="circle-btn mobile-only" data-action="about" aria-label="关于与数据管理">${icon('dots')}</button></div></header>${!storageAvailable?'<div class="storage-warning">浏览器存储不可用。本次仍可体验，关闭页面后修改可能丢失；可在数据管理中导出。</div>':''}${views[state.view]()}</main><nav class="mobile-nav" aria-label="主导航">${nav(true)}</nav>`;
}

function pageIntro(eyebrow,title,sub,actions=''){return `<section class="intro compact"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="sub">${sub}</p></div>${actions?`<div class="intro-actions">${actions}</div>`:''}</section>`;}
function changeCard(){
  if(state.stage===0)return `<section class="change-card"><div class="change-copy"><div class="eyebrow">${icon('spark')}生活会变，计划也可以</div><h2>把变化交给我，<br>把选择留给你。</h2><p>下周出差，又多了一笔临时支出。<br>一起看看，怎样继续照顾你的两个目标。</p><button class="btn light" data-action="simulate">模拟一次变化 ${icon('arrow')}</button></div>${art}</section>`;
  if(state.stage===1){const p=suggest(state);return `<section class="change-card"><div class="change-copy"><div class="eyebrow">${icon('spark')}有件事，值得一起想想 · 第 ${state.cycle} 次变化</div><h2>${p.learned?'这次出差，可以接着上次的经验。':p.expense?'行程变了，预算也需要再看一眼。':p.travel?'新行程，可能影响你的练习安排。':'暂时没有可用的变化信号。'}</h2><p>${p.learned?'你确认过：出差不补练，回来先恢复一次线下课。这次先核对是否仍适合。':p.travel||p.expense?'我整理了变化和可选方案，等你决定后再更新安排。':'模拟日历和账单已断开。连接后可重新生成变化。'}</p><button class="btn light" data-action="${p.travel||p.expense?'review':'nav'}" ${p.travel||p.expense?'':'data-view="connections"'}>${p.travel||p.expense?'一起调整':'管理连接'} ${icon('arrow')}</button></div>${art}</section>`;}
  return `<section class="change-card"><div class="change-copy"><div class="eyebrow">${icon('check')}按你的选择，继续向前</div><h2>${state.proposal?.practice==='pause'?'出差不补练，回来再慢慢恢复。':'安排已经更新，按自己的节奏来。'}</h2><p>${esc(state.logs[0]?.detail??'已根据你确认的选择更新。')}</p><div class="action-row"><button class="btn light" data-action="simulate">模拟两周后 ${icon('arrow')}</button><button class="text-btn" style="color:#d2dbc7" data-action="last-plan">查看这次调整</button></div></div>${art}</section>`;
}
function goalsView(){
  const h=state.health,f=state.finance;
  return `<section class="intro"><div><div class="eyebrow">A LITTLE PROGRESS, EVERY DAY</div><h1>想要的生活，<br class="mobile-only">正在一点点靠近。</h1><p class="sub">${esc(state.profile.name)}，不必每天都完美。我们可以一起找到合适的下一步。</p></div><button class="btn desktop-only" data-action="goal-settings">${icon('edit')}调整目标</button></section>${changeCard()}<div class="dashboard-grid"><div><div class="section-heading"><h2>正在靠近的目标 <span class="muted" style="font-size:11px;margin-left:6px">02</span></h2><small>长期的事，慢慢做</small></div><div class="goal-grid"><article class="goal-card"><div class="goal-head"><div class="icon-box">${icon('leaf')}</div><span class="pill">${state.stage===2?'按新节奏':'持续进行'}</span></div><h3>给身体，也给自己<br>一点舒展的时间</h3><p class="goal-desc">每周两次瑜伽<br>让练习成为可持续的日常</p><div class="progress-info num"><strong>${h.sessions}</strong><span>/ ${h.total} 次练习</span><span class="right">${Math.round(h.sessions/h.total*100)}%</span></div><div class="progress-track" role="progressbar" aria-label="瑜伽练习进度" aria-valuemin="0" aria-valuemax="${h.total}" aria-valuenow="${Math.min(h.sessions,h.total)}"><div class="progress-fill" style="width:${Math.min(100,h.sessions/h.total*100)}%"></div></div><div class="goal-bottom"><span>至 ${date(h.deadline)}</span><button class="text-btn small-ico" data-action="goal-detail" data-id="health">看看计划 ${icon('arrow')}</button></div></article><article class="goal-card gold"><div class="goal-head"><div class="icon-box gold">${icon('wallet')}</div><span class="pill warm">${f.plan?'已调整':'稳步积累'}</span></div><h3>为下一次成长，<br>留一笔进修预算</h3><p class="goal-desc">攒够 ${money(f.target)}<br>${f.plan?'按你确认的新安排继续储蓄':'兼顾今天，也为未来留一点'}</p><div class="progress-info num"><strong>${money(f.saved)}</strong><span>已存</span><span class="right">${Math.round(f.saved/f.target*100)}%</span></div><div class="progress-track" role="progressbar" aria-label="进修储蓄进度" aria-valuemin="0" aria-valuemax="${f.target}" aria-valuenow="${Math.min(f.saved,f.target)}"><div class="progress-fill" style="width:${Math.min(100,f.saved/f.target*100)}%"></div></div><div class="goal-bottom"><span>至 ${date(f.deadline)}</span><button class="text-btn small-ico" data-action="goal-detail" data-id="finance">看看计划 ${icon('arrow')}</button></div></article></div><section class="next-section"><div class="section-heading"><h2>接下来，可以做这些</h2><button class="text-btn small-ico" data-action="nav" data-view="tasks">全部任务 ${icon('arrow')}</button></div>${state.tasks.filter(t=>t.status==='todo').slice(0,3).map(taskRow).join('')||'<p class="muted">这一段已经完成，给自己一点留白。</p>'}</section></div><aside class="dashboard-aside"><section class="aside-panel"><div class="eyebrow">A NOTE FOR YOU</div><h3>${state.stage===2?'好的计划，<br>会给真实生活留位置。':'每次重新开始，<br>都有积累可以依靠。'}</h3><p>${state.stage===2?'你的目标仍在这里。接下来，我们会参考这次确认过的取舍，也允许你随时改变。':'目标可以持续，节奏可以变化。中断后，先找到一个愿意重新开始的小动作。'}</p><div class="aside-line"><span class="mini-source">你始终拥有最后的决定权</span>${icon('leaf')}</div></section><section class="memory-snippet"><div class="section-heading"><h2 style="font-size:13px">我记得，也可以改</h2>${icon('memory')}</div><p>${esc(activeMemory(state,'travel-restart')?.text??'平时更喜欢线下瑜伽，周末上午比较方便。')}</p><button class="text-btn small-ico" data-action="nav" data-view="memory">查看你的记忆 ${icon('arrow')}</button><div class="aside-line"><span class="mini-source">${state.connections.filter(c=>c.connected).length} 个模拟连接</span><div class="connection-icons">${state.connections.filter(c=>c.connected).map(c=>`<span>${icon(c.icon)}</span>`).join('')}</div></div></section></aside></div><div class="bottom-note">${icon('shield')}虚构人物与示例数据 · 由透明规则驱动 · 不连接真实账户</div>`;
}
function taskRow(t){return `<article class="task-mini"><button class="check-btn ${t.status==='done'?'done':''}" data-action="task" data-id="${esc(t.id)}" aria-label="${t.status==='done'?'撤销完成':'完成'}：${esc(t.title)}">${t.status==='done'?icon('check'):''}</button><div class="task-content"><h3>${esc(t.title)}</h3><p>${esc(t.note)}</p></div><span class="pill ${t.goal==='finance'?'warm':''}">${t.goal==='health'?'健康':'储蓄'}</span></article>`;}
function connectionsView(){return `${pageIntro('CONNECTED, WITH YOUR PERMISSION','让生活里的线索，连起来。','选择你愿意分享的信息，随时可以断开。')}<div class="notice">${icon('info')}以下都是模拟连接，用于体验数据如何影响建议。没有读取手机、健康或支付账户。</div><div class="list-stack">${state.connections.map(c=>`<article class="surface"><div class="connection-card"><div class="icon-box ${c.color==='orange'?'gold':c.color==='rose'?'rose':'purple'}">${icon(c.icon)}</div><div class="connection-content"><h3>${c.name} <span class="pill outline" style="margin-left:6px">模拟</span></h3><p>${c.subtitle}</p><div class="connection-detail"><span>${c.scope}</span><span>${c.connected?'已连接 · 当前为示例快照':'已断开 · 不再用于新的变化'}</span></div></div><button class="toggle" role="switch" aria-label="${c.name}模拟连接" aria-checked="${c.connected}" data-action="connection" data-id="${c.id}"></button></div>${c.connected?`<div class="connection-signal">${icon('check')} <span style="margin-left:7px">${c.signal}</span></div>`:''}</article>`).join('')}</div><div class="bottom-note">断开连接会移除本次待确认的对应信号。已经确认的目标和记忆由你单独管理。</div>`;}
function memoryView(){return `${pageIntro('UNDERSTOOD, NEVER DEFINED','关于你，始终由你定义。','事实、临时情况和推测分开保存。每条记忆都有来处。',`<button class="btn" data-action="add-memory">${icon('plus')}添加记忆</button>`)}<div class="notice">${icon('shield')}只有你确认且启用的记忆，才会参与下一次安排。一次例外，不会自动成为永久偏好。</div><div class="list-stack">${state.memories.map(m=>`<article class="surface memory-card ${m.active?'':'inactive'}"><div class="memory-top"><span class="pill ${m.kind==='hypothesis'?'hypothesis':'outline'}">${m.kind==='confirmed'?'你已确认':m.kind==='rejected'?'已被纠正':'待验证假设'}</span>${m.kind==='confirmed'?`<button class="toggle" role="switch" aria-label="启用记忆：${esc(m.text)}" aria-checked="${m.active}" data-action="memory-toggle" data-id="${m.id}"></button>`:'<span class="mini-source">不参与安排</span>'}</div><p>${esc(m.text)}</p><div class="memory-meta"><span>来源 · ${esc(m.source)}</span><span>范围 · ${esc(m.scope)}</span><span>有效期 · ${m.expires?date(m.expires):'直到你修改'}</span></div><div class="memory-actions"><button class="text-btn small-ico" data-action="edit-memory" data-id="${m.id}">${icon('edit')}纠正内容</button><button class="text-btn small-ico" data-action="delete-memory" data-id="${m.id}">${icon('trash')}删除</button></div></article>`).join('')||'<div class="empty-state">还没有记忆。可以先告诉我一件与你的目标有关的事。</div>'}</div>`;}
function knowledgeView(){return `${pageIntro('LESSONS THAT STAY','把资料与经验，变成积累。','资料帮助理解这次任务，方法帮助下一次更顺利。',`<button class="btn" data-action="add-knowledge">${icon('plus')}添加资料</button>`)}${state.skillPending?`<div class="notice">${icon('spark')}出差后的恢复任务已完成。你可以把这次确认的方法保存下来，继续观察是否有效。<button class="text-btn" data-action="save-skill" style="white-space:nowrap">保存方法 ${icon('arrow')}</button></div>`:''}<div class="kb-grid">${state.knowledge.map(k=>`<article class="surface kb-card"><div class="kb-top"><div class="icon-box ${k.type==='合作方法'?'':'gold'}">${icon(k.type==='合作方法'?'spark':'file')}</div><span class="pill ${k.type==='合作方法'?'':'warm'}">${esc(k.type)}</span></div><h3>${esc(k.title)}</h3><p>${esc(k.content)}</p><span class="mini-source">${esc(k.scope)} · ${esc(k.source)}</span><button class="text-btn small-ico" data-action="knowledge-detail" data-id="${k.id}">打开看看 ${icon('arrow')}</button></article>`).join('')}</div><div class="bottom-note">添加的资料保存在本浏览器。此版本支持文字与 TXT / Markdown，不会自动解析 PDF。</div>`;}
function tasksView(){const done=state.taskFilter==='done';return `${pageIntro('ONE STEP AT A TIME','让下一步，清楚一点。','每项任务连接一个目标；完成之后，再看看方法是否合适。',`<button class="btn" data-action="add-task">${icon('plus')}添加任务</button>`)}${state.skillPending?`<div class="notice">${icon('spark')}一次经验可以留下来，但不急着把它当定律。<button class="text-btn" data-action="save-skill">保存合作方法 ${icon('arrow')}</button></div>`:''}<div class="tabs" role="tablist" aria-label="任务状态"><button class="tab ${!done?'active':''}" role="tab" aria-selected="${!done}" data-action="task-filter" data-filter="todo">未完成<span>${state.tasks.filter(t=>t.status==='todo').length}</span></button><button class="tab ${done?'active':''}" role="tab" aria-selected="${done}" data-action="task-filter" data-filter="done">已完成<span>${state.tasks.filter(t=>t.status==='done').length}</span></button></div><div class="surface task-list" role="tabpanel">${state.tasks.filter(t=>t.status===(done?'done':'todo')).map(taskRow).join('')||`<div class="empty-state">${done?'还没有完成记录。准备好时，先做一件小事。':'这一段的任务都已完成。'}</div>`}</div>${state.logs.length?`<section class="history"><div class="section-heading"><h2>为什么改过计划</h2><small>保留理由，也允许改变</small></div>${state.logs.map(l=>`<div class="history-item"><small>模拟进程 · 第 ${l.cycle} 次</small><h3>${esc(l.text)}</h3><p>${esc(l.detail)}</p></div>`).join('')}</section>`:''}`;}

function openModal(title,subtitle,body,footer='',kind=''){
  modalKind=kind;
  sheet.innerHTML=`<div class="modal-top"><h2 id="sheet-title">${title}</h2><button class="circle-btn" data-action="close" aria-label="关闭">${icon('close')}</button></div>${subtitle?`<p class="modal-sub">${subtitle}</p>`:''}${body}${footer?`<div class="modal-footer">${footer}</div>`:''}`;
  if(!sheet.open)sheet.showModal();
}
function closeModal(){sheet.close();modalKind='';}
function review(){
  const p=suggest(state), ext=financePreview(state,'extend'), cat=financePreview(state,'catchup');
  formDraft={finance:p.finance,practice:p.practice,remember:Boolean(activeMemory(state,'travel-restart'))};
  openModal('变化之后，一起调整。',`模拟进程 · 第 ${state.cycle} 次 · 所有调整都等你确认`,
    `<div class="modal-section" style="margin-top:12px"><h3>我目前知道的</h3>${p.reasons.map(r=>`<div class="evidence"><span class="pill ${r.type==='hypothesis'?'hypothesis':'outline'}">${r.type==='fact'?'事实':r.type==='memory'?'记忆':'推测'}</span><div><p>${esc(r.text)}</p><small>${esc(r.source)}</small></div></div>`).join('')}</div>
    ${p.expense?`<section class="modal-section"><h3>01 / 进修储蓄，如何取舍？</h3><label class="choice"><input type="radio" name="finance" value="extend" checked><strong>保留日常安排，进修延后一个月</strong><small>本月预留 ${money(ext.now)}，后续 ${ext.laterMonths} 个月每月 ${money(ext.later)}。瑜伽支出不变。</small></label><label class="choice"><input type="radio" name="finance" value="catchup"><strong>保留进修日期，后续分月补足</strong><small>本月预留 ${money(cat.now)}，后续 ${cat.laterMonths} 个月每月 ${money(cat.later)}。请先确认现金流能否承受。</small></label><div id="finance-calc">${calcHTML(financePreview(state,'extend'))}</div></section>`:''}
    ${p.travel?`<section class="modal-section"><h3>${p.expense?'02':'01'} / 出差期间，怎样练习？</h3><label class="choice"><input type="radio" name="practice" value="pause" ${p.practice==='pause'?'checked':''}><strong>出差不补练，回来先恢复一次线下课</strong><small>保留长期目标，暂时调整这次行程的节奏。</small></label><label class="choice"><input type="radio" name="practice" value="home" ${p.practice==='home'?'checked':''}><strong>尝试一次居家短练习</strong><small>这是一项待验证的选择，试过后再判断是否适合。</small></label></section><label class="checkbox-row"><input type="checkbox" id="remember-choice" ${formDraft.remember?'checked':''}><span>若选择“不补练”，记住为我的出差恢复方式。<br><span class="muted">范围仅限健康目标的出差中断，随时可以停用。</span></span></label>`:''}
    <label class="field">还有什么需要我知道？（可选）<textarea id="adjustment-note" maxlength="1000" placeholder="例如：线下瑜伽对我很重要；这次只是临时出差。"></textarea></label><p class="export-note">自由补充会作为本次原话保存；不会自动生成新的人格或财务判断。</p><p id="form-error" class="error-text" role="alert"></p>`,
    '<button class="btn" data-action="close">暂不调整</button><button class="btn primary" data-action="apply">确认并更新安排 '+icon('check')+'</button>','review');
}
function calcHTML(p){return `<div class="calc num"><div>本月预留<strong>${money(p.now)}</strong></div><div>后续每月 × ${p.laterMonths}<strong>${money(p.later)}</strong></div><div>完成时间<strong>${date(p.deadline)}</strong></div></div>`;}
function guide(){openModal('用三次变化，感受一次积累。','虚构用户林悦 · 约 3 分钟可走完核心流程',`<div class="guide-step"><span class="step-no">1</span><div><h3>看看生活如何影响两个目标</h3><p>在目标页点“模拟一次变化”，查看出差与 ¥1,800 临时支出。</p></div></div><div class="guide-step"><span class="step-no">2</span><div><h3>做一个符合自己的选择</h3><p>决定储蓄期限和练习安排。选择“不补练”后，可勾选记住这套恢复方式。</p></div></div><div class="guide-step"><span class="step-no">3</span><div><h3>两周后，观察经验怎样复用</h3><p>点“模拟两周后”。确认过且启用的记忆才参与建议。也可以先去记忆页停用它，比较差异。</p></div></div><div class="guide-step"><span class="step-no">4</span><div><h3>让做过的事留下方法</h3><p>完成调整后的练习任务，再把合作方法保存进知识库。方法仍注明证据和失效条件。</p></div></div><p class="export-note">这是可操作的规则驱动原型，不是实时大模型服务。数据留在当前浏览器；模拟时间不会自动推进。</p>`,`<button class="btn primary" data-action="close">开始体验 ${icon('arrow')}</button>`);}
function about(){openModal('一个人，也能慢慢向前。','Along · Personality Demo',`<p>围绕健康与储蓄两个长期目标，体验个性化如何影响下一步。所有人物、连接和账单均为示例；不会发送消息、预约课程或转账。</p><div class="modal-section"><h3>在手机上使用</h3><p>iPhone：Safari → 分享 → 添加到主屏幕。<br>Android：Chrome → 菜单 → 安装应用 / 添加到主屏幕。<br>电脑也可以直接使用浏览器。</p></div><div class="modal-section"><h3>你的数据</h3><p>修改保存在此设备的浏览器中，不跨设备同步。清理浏览器数据会移除记录，可以先导出备份。</p><div class="action-row"><button class="btn" data-action="export">${icon('download')}导出体验数据</button><button class="btn" data-action="import-data">${icon('upload')}导入备份</button></div></div><div class="danger-zone"><p>想重新走一遍故事？</p><button class="text-btn" data-action="reset">${icon('reset')}重置示例</button></div>`,`<button class="btn primary" data-action="close">知道了</button>`);}

function goalDetail(id){const health=id==='health',f=state.finance,h=state.health;openModal(health?'给身体，也给自己一点时间。':'为下一次成长，留一笔预算。',health?'健康目标 · 练习次数是行为记录，不代表身体效果':'进修储蓄目标 · 只安排与记录，不执行转账',`<div class="split-info"><div><small>${health?'已完成练习':'已经存下'}</small><strong>${health?`${h.sessions} / ${h.total} 次`:money(f.saved)}</strong></div><div><small>当前期限</small><strong>${date(health?h.deadline:f.deadline)}</strong></div></div>${health?`<p>希望通过可持续的瑜伽练习，为塑形与正念留出时间。是否适合、是否感到不适，需要结合你的反馈；不会仅凭完成次数推断身体变化。</p>`:`<p>目标 ${money(f.target)}，还差 ${money(Math.max(0,f.target-f.saved))}。${f.plan?`本月 ${money(f.plan.now)}，之后 ${f.plan.laterMonths} 个月每月 ${money(f.plan.later)}。`:`原计划每月 ${money(f.plannedMonthly)}。`}</p>`}<section class="modal-section"><h3>关联的下一步</h3>${state.tasks.filter(t=>t.goal===id&&t.status==='todo').map(t=>`<div class="log-box"><p>${esc(t.title)}</p><small class="muted">${esc(t.note)}</small></div>`).join('')||'<p class="muted">当前任务已完成。</p>'}</section><div class="modal-section"><h3>这些信息影响了安排</h3>${state.memories.filter(m=>m.active&&(health?m.scope.includes('健康'):m.scope.includes('储蓄'))).map(m=>`<p style="margin-top:8px">${esc(m.text)}</p>`).join('')}</div>`,`<button class="btn" data-action="goal-settings">调整目标</button><button class="btn primary" data-action="close">继续向前</button>`);}
function goalSettings(){openModal('让目标符合现在的你。','修改期限或起点后，现有储蓄方案需要重新核对。',`<form id="goal-form"><label class="field">你希望怎么称呼你<input name="name" maxlength="24" required value="${esc(state.profile.name)}"></label><label class="field">瑜伽练习目标（次数）<input name="sessions" type="number" min="1" max="1000" required value="${state.health.total}"></label><label class="field">进修预算（元）<input name="target" type="number" min="1" max="100000000" required value="${state.finance.target}"></label><label class="field">当前已存（元）<input name="saved" type="number" min="0" max="100000000" required value="${state.finance.saved}"></label><label class="field">希望完成储蓄的日期<input name="deadline" type="date" min="2026-11-01" max="2035-12-31" required value="${state.finance.deadline}"></label><p class="export-note">更改预算时会取消旧方案，清除旧储蓄任务的金额贡献并要求重新核对；不会沿用过时的分月安排。</p><p id="form-error" class="error-text" role="alert"></p></form>`,`<button class="btn primary" data-action="save-goals">保存目标</button>`);}
function memoryEditor(id){const m=state.memories.find(m=>m.id===id);openModal(m?'纠正这条记忆':'告诉我一件重要的事','你确认的内容才会参与后续安排。',`<form id="memory-form"><label class="field">记忆内容<textarea name="text" required maxlength="1000" placeholder="例如：练习对我来说也是放松，不希望只追求完成次数。">${esc(m?.text??'')}</textarea></label><label class="field">适用范围<select name="scope"><option ${m?.scope==='健康目标'?'selected':''}>健康目标</option><option ${m?.scope==='健康目标 · 出差中断后'?'selected':''}>健康目标 · 出差中断后</option><option ${m?.scope==='进修储蓄目标'?'selected':''}>进修储蓄目标</option><option ${m?.scope==='两个目标之间的取舍'?'selected':''}>两个目标之间的取舍</option></select></label><label class="field">到期时间（可不填）<input type="date" name="expires" min="2026-10-20" value="${m?.expires??''}"></label><p class="export-note">此原型不会从任意文字自动推导操作。修改已关联的方法后，需要重新确认具体安排。</p><p id="form-error" class="error-text" role="alert"></p></form>`,`<button class="btn primary" data-action="save-memory" data-id="${id??''}">确认保存</button>`);}
function knowledgeEditor(){openModal('留下有用的资料。','支持粘贴文字，或导入 TXT / Markdown。',`<form id="knowledge-form"><label class="field">标题<input name="title" maxlength="100" required placeholder="例如：课程安排与请假规则"></label><label class="field">用于哪个目标<select name="scope"><option>健康目标</option><option>进修储蓄目标</option><option>两个目标</option></select></label><label class="field">从文件导入（可选）<input type="file" id="knowledge-file" accept=".txt,.md,text/plain,text/markdown"></label><label class="field">资料内容<textarea name="content" required maxlength="30000" placeholder="记录事实、条件与来源。"></textarea></label><p class="export-note">保存后可查阅；当前原型不会自动理解任意资料并修改建议。</p><p id="form-error" class="error-text" role="alert"></p></form>`,`<button class="btn primary" data-action="save-knowledge">保存到知识库</button>`);}
function taskEditor(){openModal('给目标，添一个小动作。','自建任务完成后会留下记录，不自动推断储蓄金额或身体效果。',`<form id="task-form"><label class="field">下一步做什么<input name="title" required maxlength="120" placeholder="例如：确认返程后的周末课程"></label><label class="field">关联目标<select name="goal"><option value="health">健康目标</option><option value="finance">进修储蓄目标</option></select></label><label class="field">时间或说明<input name="note" maxlength="200" placeholder="例如：周五下班后，用 10 分钟"></label><p id="form-error" class="error-text" role="alert"></p></form>`,`<button class="btn primary" data-action="save-task">加入未完成任务</button>`);}

async function act(action,el){
  const id=el?.dataset.id;
  if(action==='nav'){if(sheet.open)closeModal();go(el.dataset.view);}
  if(action==='close')closeModal();
  if(action==='guide')guide();
  if(action==='about')about();
  if(action==='simulate'){
    if(state.stage===1){review();return;}
    commit(triggerChange(state));
    notify(state.cycle===1?'已载入一次模拟变化，点“一起调整”查看。':'模拟时间已推进；建议会重新检查当前有效的记忆。');
  }
  if(action==='review')review();
  if(action==='apply'){
    try{
      const data={finance:sheet.querySelector('[name=finance]:checked')?.value??'keep',practice:sheet.querySelector('[name=practice]:checked')?.value??'pause',remember:sheet.querySelector('#remember-choice')?.checked??false,note:sheet.querySelector('#adjustment-note').value};
      commit(applyProposal(state,data));closeModal();notify('目标、任务和适用的记忆已一起更新。');
    }catch(e){sheet.querySelector('#form-error').textContent=e.message;}
  }
  if(action==='last-plan')openModal('这次为什么这样安排。','已由你确认 · 没有执行任何外部操作',`<p>${esc(state.logs[0]?.detail)}</p>${state.finance.plan?calcHTML(state.finance.plan):''}<div class="modal-section"><h3>原话补充</h3><p>${esc(state.feedback.filter(f=>f.cycle===state.cycle&&!f.taskId).map(f=>f.text).join('\n')||'本次没有额外补充。')}</p></div>`,`<button class="btn primary" data-action="close">知道了</button>`);
  if(action==='connection'){
    const s=structuredClone(state),c=s.connections.find(c=>c.id===id);c.connected=!c.connected;
    if(!c.connected&&s.stage===1)s.events=s.events.filter(e=>!(id==='calendar'&&e.type==='travel'||id==='bills'&&e.type==='expense'));
    if(c.connected&&s.stage===1){s.stage=0;commit(triggerChange(s));}else commit(s);
    notify(c.connected?'模拟连接已启用。':'模拟连接已断开；已确认内容由你单独管理。');
  }
  if(action==='task-filter'){state.taskFilter=el.dataset.filter;persist();render();}
  if(action==='task'){
    const t=state.tasks.find(t=>t.id===id);
    if(t.status==='done'){commit(toggleTask(state,id));notify('已撤销完成，同时还原相关进度。');return;}
    openModal('这一步，完成得怎么样？',esc(t.title),`<p class="muted">${esc(t.note)}</p><label class="field">反馈（可选）<textarea id="task-feedback" maxlength="1000" placeholder="例如：这样安排更容易开始，希望下次继续。"></textarea></label><p class="export-note">完成只代表任务记录；不自动推断身体改善或方法已长期有效。</p>`,`<button class="btn primary" data-action="complete-task" data-id="${id}">记录完成 ${icon('check')}</button>`);
  }
  if(action==='complete-task'){
    const text=sheet.querySelector('#task-feedback').value;
    commit(toggleTask(state,id,text));closeModal();
    if(state.skillPending)notify('已完成。可以到知识库保存这次合作方法。');else notify('这一步已经记下，进度已更新。');
  }
  if(action==='save-skill'){
    commit(saveSkill(state));notify('合作方法已保存，并注明了证据与暂停条件。');
  }
  if(action==='goal-detail')goalDetail(id);
  if(action==='goal-settings')goalSettings();
  if(action==='save-goals'){
    const form=sheet.querySelector('form');if(!form.reportValidity())return;
    const f=new FormData(form),target=Number(f.get('target')),saved=Number(f.get('saved'));
    if(saved>target){sheet.querySelector('#form-error').textContent='当前已存不能高于目标预算；可以先提高目标。';return;}
    const s=structuredClone(state),changed=target!==s.finance.target||saved!==s.finance.saved||f.get('deadline')!==s.finance.deadline;
    s.profile.name=f.get('name').trim()||'林悦';s.health.total=Number(f.get('sessions'));
    if(changed){
      s.finance.target=target;s.finance.saved=saved;s.finance.deadline=f.get('deadline');s.finance.plan=null;
      const deadline=new Date(s.finance.deadline+'T00:00:00Z');s.finance.months=Math.max(1,(deadline.getUTCFullYear()-2026)*12+deadline.getUTCMonth()-9);s.finance.plannedMonthly=Math.ceil((target-saved)/s.finance.months);
      const t=s.tasks.find(t=>t.id==='t-save');if(t){t.contribution=0;t.status='todo';t.title='重新核对储蓄安排';t.note='目标已修改，请先核对新的预算与期限';t.tag='待核对';}
      const m=s.memories.find(m=>m.key==='budget');if(m){m.text=`进修预算 ${money(target)}，当前已存 ${money(saved)}，期望完成日期 ${s.finance.deadline}；旧分月方案已失效。`;m.source='用户手动修改目标';}
      s.stage=0;s.cycle=1;s.events=[];s.proposal=null;s.logs.unshift({id:uid('log'),text:'你修改了目标',detail:'旧储蓄方案已失效，等待重新核对。',cycle:s.cycle});
    }
    commit(s);closeModal();notify('目标已更新。'+(changed?'旧储蓄安排已停用。':''));
  }
  if(action==='add-memory')memoryEditor();
  if(action==='edit-memory')memoryEditor(id);
  if(action==='save-memory'){
    const form=sheet.querySelector('form');if(!form.reportValidity())return;const f=new FormData(form),text=f.get('text').trim();
    if(!text){sheet.querySelector('#form-error').textContent='请写下要记住的具体内容。';return;}
    let s=structuredClone(state);
    if(id)s=editMemory(s,id,{text,scope:f.get('scope'),active:true});
    else s.memories.push({id:uid('m'),key:'custom',text,scope:f.get('scope'),source:'用户主动添加',active:true,kind:'confirmed',expires:f.get('expires')||null});
    if(id){const m=s.memories.find(m=>m.id===id);m.expires=f.get('expires')||null;m.kind='confirmed';}
    commit(s);closeModal();notify('记忆已更新。当前已确认的计划不会被悄悄改动。');
  }
  if(action==='memory-toggle'){
    const m=state.memories.find(m=>m.id===id);commit(editMemory(state,id,{active:!m.active}));notify(m.active?'已停用；下一次不再参考这条记忆。':'已启用；下次仍会检查适用情境。');
  }
  if(action==='delete-memory'){
    const m=state.memories.find(m=>m.id===id);openModal('删除这条记忆？','后续建议不再使用它，已确认的计划仍保留。',`<p>${esc(m.text)}</p>`,`<button class="btn" data-action="close">保留</button><button class="btn primary" data-action="confirm-delete-memory" data-id="${id}">删除记忆</button>`);
  }
  if(action==='confirm-delete-memory'){const s=structuredClone(state);s.memories=s.memories.filter(m=>m.id!==id);commit(s);closeModal();notify('这条记忆已删除。');}
  if(action==='add-knowledge')knowledgeEditor();
  if(action==='save-knowledge'){
    const form=sheet.querySelector('form');if(!form.reportValidity())return;const f=new FormData(form),title=f.get('title').trim(),content=f.get('content').trim();
    if(!title||!content){sheet.querySelector('#form-error').textContent='请填写标题与资料内容。';return;}
    const s=structuredClone(state);s.knowledge.push({id:uid('k'),title,content,scope:f.get('scope'),source:'用户添加 · 本地保存',type:'资料',created:'2026-10-20'});commit(s);closeModal();notify('资料已保存，可随时查阅或删除。');
  }
  if(action==='knowledge-detail'){
    const k=state.knowledge.find(k=>k.id===id);openModal(esc(k.title),`${esc(k.type)} · ${esc(k.scope)} · ${esc(k.source)}`,`<div class="document-body">${esc(k.content)}</div>`,`<button class="btn" data-action="delete-knowledge" data-id="${id}">${icon('trash')}删除</button><button class="btn primary" data-action="close">看完了</button>`);
  }
  if(action==='delete-knowledge'){const s=structuredClone(state);s.knowledge=s.knowledge.filter(k=>k.id!==id);commit(s);closeModal();notify('资料已移除。');}
  if(action==='add-task')taskEditor();
  if(action==='save-task'){
    const form=sheet.querySelector('form');if(!form.reportValidity())return;const f=new FormData(form),title=f.get('title').trim();if(!title){sheet.querySelector('#form-error').textContent='请填写一个具体动作。';return;}
    const s=structuredClone(state);s.tasks.push({id:uid('t'),title,note:f.get('note').trim()||'按自己的节奏开始',goal:f.get('goal'),status:'todo',tag:'待开始',contribution:0,generated:false});commit(s);closeModal();notify('已加入未完成任务。');
  }
  if(action==='export'){
    const url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='along-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('已导出当前浏览器的体验数据。');
  }
  if(action==='import-data'){
    const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
    input.onchange=async()=>{try{if(input.files[0].size>2000000)throw new Error('备份不能超过 2 MB。');const raw=JSON.parse(await input.files[0].text());const loaded=loadState(raw);if(loaded===raw){formDraft=loaded;openModal('用备份替换当前体验？','这会覆盖当前浏览器里的目标、记忆和任务。',`<p>备份用户：${esc(loaded.profile.name)}<br>${loaded.memories.length} 条记忆，${loaded.tasks.length} 个任务。</p>`,`<button class="btn" data-action="close">取消</button><button class="btn primary" data-action="confirm-import">确认导入</button>`);}else throw new Error('这不是兼容的 Along 备份。');}catch(e){notify(e.message||'无法读取备份。');}};input.click();
  }
  if(action==='confirm-import'){commit(formDraft);closeModal();notify('备份已导入。');}
  if(action==='reset')openModal('重新开始这个故事？','当前浏览器里的体验修改将被示例数据替换。你可以先导出备份。','<p>重新从林悦的健康与进修目标开始，再试一次不同选择。</p>','<button class="btn" data-action="close">保留当前进度</button><button class="btn primary" data-action="confirm-reset">重置示例</button>');
  if(action==='confirm-reset'){commit(createState());closeModal();notify('示例已重置。');}
}

document.addEventListener('click',event=>{const el=event.target.closest('[data-action]');if(!el||el.disabled)return;event.preventDefault();Promise.resolve(act(el.dataset.action,el)).catch(error=>notify(error.message||'操作未完成，请再试一次。'));});
document.addEventListener('change',async event=>{
  if(event.target.name==='finance'&&modalKind==='review')sheet.querySelector('#finance-calc').innerHTML=calcHTML(financePreview(state,event.target.value));
  if(event.target.id==='knowledge-file'){
    const file=event.target.files?.[0];if(!file)return;
    if(file.size>100000){sheet.querySelector('#form-error').textContent='请选择 100 KB 以内的文字资料。';return;}
    if(!/\.(txt|md)$/i.test(file.name)){sheet.querySelector('#form-error').textContent='请使用 TXT 或 Markdown 文件。';return;}
    sheet.querySelector('[name=content]').value=(await file.text()).slice(0,30000);
    if(!sheet.querySelector('[name=title]').value)sheet.querySelector('[name=title]').value=file.name.replace(/\.(txt|md)$/i,'');
    sheet.querySelector('#form-error').textContent='';
  }
});
sheet.addEventListener('click',event=>{if(event.target===sheet){const r=sheet.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeModal();}});
sheet.addEventListener('close',()=>{modalKind='';});
render();
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
