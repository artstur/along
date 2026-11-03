import {KEY, loadState, addGoal, removeGoal, setSnapshot, advanceWeightDemo, taskPlan} from './health.mjs';
import {EXPERIMENT, startExperiment, routeHealthEvent, acceptAgentSuggestion} from './loop.mjs';

const app = document.querySelector('#app'), sheet = document.querySelector('#sheet'), toast = document.querySelector('#toast');
let state = loadState(localStorage.getItem(KEY));
let running = false;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fmt = value => new Intl.NumberFormat('zh-CN').format(value);
const hours = mins => `${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟`;
function save(next) { state = next; localStorage.setItem(KEY, JSON.stringify(state)); render(); }
function notice(text) { toast.textContent = text; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 3500); }
function show(html) { sheet.innerHTML = html; sheet.showModal(); }
function metric(name, value, unit, caption, glyph) { return `<article class="metric"><div class="metric-label">${name}<span>${glyph}</span></div><div class="metric-value">${value}<small>${unit}</small></div><p>${caption}</p></article>`; }
function experimentPanel() {
  const loop = state.loop?.experiment === EXPERIMENT ? state.loop : null;
  const latest = loop?.changes?.find(item => item.decision === 'replan');
  const quiet = loop?.changes?.filter(item => item.decision === 'quiet').length ?? 0;
  return `<section class="section experiment-section"><div class="section-heading"><div><h2>目标变化实验</h2></div><span class="sync-time">模拟健康事件</span></div><div class="experiment-card">${loop ? `<div class="experiment-top"><div><strong>本周健身 120 分钟</strong><p>从 75 分钟开始，观察任务何时需要改变。</p></div><div class="experiment-links"><button class="text-button" data-action="experiment-reset">重新开始</button><button class="text-button muted" data-action="experiment-exit">结束实验</button></div></div><div class="experiment-actions"><button class="button" data-action="event-workout-35" ${running?'disabled':''}>新增 35 分钟健身</button><button class="button secondary" data-action="event-workout-1" ${running?'disabled':''}>仅新增 1 分钟</button><button class="button secondary" data-action="event-steps" ${running?'disabled':''}>仅步数变化</button></div>${latest ? `<div class="change-card"><div class="change-label">${latest.status === 'pending' ? '正在请 DSH 建议下一步…' : latest.status === 'error' ? 'DSH 暂未返回建议' : latest.source === 'live-dsh' ? 'DSH 实时建议' : 'DSH 建议回放'}</div><div class="change-flow"><div><span>原任务</span><strong>${esc(latest.beforeTask)}</strong></div><span class="flow-arrow">→</span><div><span>新任务</span><strong>${esc(latest.suggestion?.task ?? (latest.status === 'error' ? '尚未生成' : '生成中…'))}</strong></div></div><p class="change-reason">Along 计算：${latest.remainingBefore} → ${latest.remainingAfter} 分钟待完成。${esc(latest.reason)}${latest.suggestion ? ` ${esc(latest.suggestion.reason)}` : ''}</p>${latest.status === 'error' ? `<p class="change-error">${esc(latest.error)} · 可重新开始实验后再试。</p>` : ''}${latest.source === 'recorded-dsh' ? '<p class="replay-note">公网版回放一次真实 DSH 运行；在本机启动服务可实时调用 Agent。</p>' : ''}</div>` : '<p class="experiment-hint">新增 35 分钟会触发重排；轻微或无关变化不会调用 Agent。</p>'}${quiet ? `<p class="quiet-count">${quiet} 条轻微或无关变化已安静处理，没有调用 DSH。</p>` : ''}` : `<div class="experiment-top"><div><strong>看一次真实的目标驱动循环</strong><p>预设本周 120 分钟、已完成 75 分钟，再注入一条健身记录。</p></div><button class="button" data-action="experiment-start">开始实验</button></div>`}</div></section>`;
}
function render() {
  const data = state.snapshot, demo = state.source === 'demo', connected = state.source === 'healthkit', plan = taskPlan(state);
  if (state.loop?.experiment === EXPERIMENT && plan.tasks[1]) {
    const latest = state.loop.changes?.find(item => item.decision === 'replan');
    const remaining=Math.max(0,120-(data?.workoutMinutes??0));
    const currentTask=latest?.status === 'done' && latest.remainingAfter !== remaining
      ? state.loop.currentTask.replace(/\d+\s*分钟/,`${remaining}分钟`) : state.loop.currentTask;
    plan.tasks[1] = {...plan.tasks[1], title: latest?.status === 'pending' ? '等待 DSH 建议下一步' : latest?.status === 'error' ? '下一步建议暂不可用' : currentTask, detail: `本周还差 ${remaining} 分钟。`};
  }
  const selected = type => !connected || !Array.isArray(data?.selectedTypes) || data.selectedTypes.includes(type);
  const metrics = [metric('步数',data?.steps == null ? '—' : fmt(data.steps),'步',!selected('steps') ? '未选择' : data?.steps == null ? '无可读取记录' : '今天','↗'),metric('体重',data?.weightKg == null ? '—' : data.weightKg.toFixed(1),'kg',!selected('weight') ? '未选择' : data?.weightKg == null ? '无可读取记录' : '最近一次记录','◌'),metric('健身记录',data?.workoutMinutes == null ? '—' : hours(data.workoutMinutes),'',!selected('workout') ? '未选择' : data?.workoutMinutes == null ? '无可读取记录' : `本周 ${data.workoutCount} 次`,'↗'),metric('睡眠',data?.sleepMinutes == null ? '—' : `${Math.floor(data.sleepMinutes/60)}时${String(data.sleepMinutes%60).padStart(2,'0')}分`,'',!selected('sleep') ? '未选择' : data?.sleepMinutes == null ? '无可读取记录' : '昨晚','☾')].join('');
  const goals = state.goals.length ? state.goals.map(goal => { const p = plan.progress.find(item => item.id === goal.id); return `<article class="goal"><div class="goal-top"><div><span class="goal-kind">${goal.type === 'workout' ? '本周 · 健身' : '本月 · 体重'}</span><h3>${goal.type === 'workout' ? `累计健身 ${hours(goal.target)}` : `减重 ${goal.target} kg`}</h3></div><button class="icon-button" data-action="remove" data-id="${esc(goal.id)}" aria-label="删除目标">×</button></div><div class="progress-label"><span>${esc(p.label)}</span><strong>${data ? `${p.percent}%` : '—'}</strong></div><div class="track"><span style="width:${p.percent}%"></span></div><p class="goal-note">${esc(p.note)}</p></article>`; }).join('') : '<div class="empty">还没有目标。先设定这周或本月想实现的变化。</div>';
  const tasks = plan.tasks.length ? plan.tasks.map((task,index) => `<article class="task"><span class="task-index">${String(index+1).padStart(2,'0')}</span><div><div class="task-head"><h3>${esc(task.title)}</h3><span class="task-status ${task.status}">${task.status === 'done' ? '已完成' : task.status === 'active' ? '进行中' : '待进行'}</span></div><p>${esc(task.detail)}</p></div></article>`).join('') : '<div class="empty">设定目标后，这里会展示当前的下一步。</div>';
  app.innerHTML = `<div class="shell"><header class="header"><a class="brand" href="./"><span class="brand-symbol">A<span>·</span></span>along</a><span class="header-note">健康目标</span><span class="version">体验版</span></header><main class="content"><div class="hero"><div><h1>健康概览</h1><p>查看数据、设定目标，了解接下来要做什么。</p></div><div class="hero-mark" aria-hidden="true">✳</div></div><section class="section"><div class="section-heading"><div><span class="eyebrow">01 / DATA</span><h2>健康数据</h2></div><span class="sync-time">${data ? `更新于 ${new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(data.updatedAt))}` : '尚无数据'}</span></div><div class="connect-panel"><div class="connect-icon">♥</div><div class="connect-copy"><strong>Apple Health</strong><p>${connected ? '已同步所选摘要 · 权限由 iPhone 管理' : demo ? '当前显示演示数据 · 尚未连接 Apple Health' : '连接后查看步数、体重、健身和睡眠'}</p></div><span class="status ${connected ? 'connected' : demo ? 'sample' : ''}">${connected ? '已连接' : demo ? '演示中' : '未连接'}</span><button class="button" data-action="connect">${connected ? '同步数据' : '连接'}</button></div><div class="metric-grid">${metrics}</div>${demo ? '<div class="demo-controls"><span>演示数据用于预览任务如何变化</span><button class="text-button" data-action="advance-weight">模拟新的体重记录 →</button><button class="text-button muted" data-action="clear">退出演示</button></div>' : ''}</section><section class="section"><div class="section-heading"><div><span class="eyebrow">02 / GOALS</span><h2>我的目标</h2></div><button class="button add" data-action="new">＋ 设定目标</button></div><div class="goal-list">${goals}</div></section>${experimentPanel()}<section class="section"><div class="section-heading"><div><span class="eyebrow">03 / NEXT STEPS</span><h2>动态任务</h2></div><span class="sync-time">${plan.tasks.filter(task => task.status === 'done').length} / ${plan.tasks.length} 已完成</span></div><div class="task-list">${tasks}</div><p class="footnote">${state.loop?.experiment === EXPERIMENT ? '目标进度由 Along 本地计算；显著变化才请求 DSH 建议。' : demo ? '当前任务由本地规则生成，用于验证界面和数据变化。' : connected ? '任务根据当前数据和目标更新。' : '连接 Apple Health 后，任务会根据新数据更新。'}</p></section></main><footer>Along · 健康目标体验版</footer></div>`;
}
function goalForm() {
  show(`<div class="sheet-head"><div><span class="eyebrow">NEW GOAL</span><h2>设定一个目标</h2></div><button class="icon-button" data-action="close" aria-label="关闭">×</button></div><form id="goal-form"><label>目标类型<select name="type"><option value="workout">本周健身总时长</option><option value="weight">本月减重</option></select></label><label>希望达到<input name="target" type="number" min="0.1" max="168" step="0.1" required value="2"><small id="goal-unit">小时</small></label><p class="form-hint">目标可以随时删除，再重新设定。</p><button class="button submit" type="submit">保存目标</button></form>`);
  sheet.querySelector('select').addEventListener('change', event => { sheet.querySelector('#goal-unit').textContent = event.target.value === 'workout' ? '小时' : 'kg'; sheet.querySelector('input').max = event.target.value === 'workout' ? '168' : '100'; });
}
function connectInfo() { show(`<div class="sheet-head"><div><span class="eyebrow">APPLE HEALTH</span><h2>连接健康数据</h2></div><button class="icon-button" data-action="close" aria-label="关闭">×</button></div><p class="sheet-copy">Apple Health 需要 iPhone 应用授权。当前网页无法读取健康数据；接入 iOS 应用后，这里会请求步数、体重、健身和睡眠的读取权限。</p><div class="permission-list"><span>步数</span><span>体重</span><span>健身记录</span><span>睡眠</span></div><button class="button submit" data-action="demo">先用演示数据体验</button><p class="form-hint">演示数据不会显示为真实连接。</p>`); }
async function connect() {
  if (!window.AlongHealthBridge?.connect) { connectInfo(); return; }
  try { const snapshot = await window.AlongHealthBridge.connect({types:['steps','weight','workout','sleep']}); save(setSnapshot(state,snapshot,'healthkit')); notice('健康数据已同步'); }
  catch(error) { notice(error?.message || '连接未完成，请检查健康权限'); }
}
async function injectEvent(event) {
  if (running) return;
  const before=state;
  let route;
  try { route=routeHealthEvent(before,event); } catch(error) { notice(error.message); return; }
  const id=crypto.randomUUID();
  const entry={id,type:event.type,amount:event.amount,decision:route.decision,reason:route.reason,remainingBefore:route.remainingBefore,remainingAfter:route.remainingAfter,beforeTask:before.loop.currentTask,status:route.decision==='quiet'?'quiet':'pending'};
  if (route.decision==='replan') running=true;
  save({...route.after,loop:{...before.loop,changes:[entry,...before.loop.changes]}});
  if (route.decision==='quiet') return;
  try {
    let result;
    const response=await fetch('./api/health-event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({before,event})});
    if ([404,405,501].includes(response.status) && before.snapshot.workoutMinutes===75 && event.type==='workout' && event.amount===35) {
      const replay=await fetch('./agent-replay.json').then(res=>res.json());
      if(replay.experiment!==EXPERIMENT||replay.beforeMinutes!==75||replay.eventMinutes!==35)throw Error('回放场景不匹配');
      result={decision:'replan',source:'recorded-dsh',suggestion:replay.suggestion};
    } else {
      result=await response.json();
      if(!response.ok)throw Error(result.error||'DSH 请求失败');
    }
    if(result.decision!=='replan')throw Error('服务端没有确认重排');
    const suggestion=acceptAgentSuggestion(JSON.stringify(result.suggestion),route.remainingAfter);
    if(state.loop?.changes?.[0]?.id!==id)return;
    save({...state,loop:{...state.loop,currentTask:suggestion.task,changes:[{...entry,status:'done',suggestion,source:result.source},...state.loop.changes.slice(1)]}});
  } catch(error) {
    if(state.loop?.changes?.[0]?.id===id)save({...state,loop:{...state.loop,changes:[{...entry,status:'error',error:error.message},...state.loop.changes.slice(1)]}});
  } finally { running=false; render(); }
}
app.addEventListener('click',event => { const button=event.target.closest('[data-action]'); if (!button) return; const action=button.dataset.action; if (action==='connect') connect(); if (action==='new') goalForm(); if (action==='remove') { if(button.dataset.id===EXPERIMENT && state.loop?.experiment===EXPERIMENT) save(state.loop.previousState??loadState(null)); else save(removeGoal(state,button.dataset.id)); notice('目标已删除'); } if (action==='experiment-start'||action==='experiment-reset') { if(!running)save(startExperiment(state)); } if (action==='experiment-exit'&&!running) save(state.loop?.previousState??loadState(null)); if (action==='event-workout-35') injectEvent({type:'workout',amount:35}); if (action==='event-workout-1') injectEvent({type:'workout',amount:1}); if (action==='event-steps') injectEvent({type:'steps',amount:100}); if (action==='advance-weight') { save(advanceWeightDemo(state)); notice('体重记录已更新'); } if (action==='clear') save(state.loop?.experiment===EXPERIMENT ? state.loop.previousState??loadState(null) : {...state,source:null,snapshot:null,loop:null,goals:state.goals.map(goal => goal.type === 'weight' ? {...goal,baselineWeight:null,weightRecords:0} : goal)}); });
sheet.addEventListener('click',event => { const action=event.target.closest('[data-action]')?.dataset.action; if (action==='close') sheet.close(); if (action==='demo') { save(setSnapshot(state,{steps:6842,weightKg:64.2,workoutMinutes:75,workoutCount:2,sleepMinutes:437},'demo')); sheet.close(); } });
sheet.addEventListener('submit',event => { if (event.target.id!=='goal-form') return; event.preventDefault(); const form=new FormData(event.target); try { save(addGoal(state,form.get('type'),Number(form.get('target')))); sheet.close(); notice('目标已保存，任务已更新'); } catch(error) { notice(error.message); } });
render();
