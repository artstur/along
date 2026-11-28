import {readableResultText,resultPreview} from './task-result-view.mjs?v=104';
// A bounded optional extension to the existing message protocol. No model HTML reaches the DOM.
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(v);
const instant=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));
const strings=(v,max,count)=>Array.isArray(v)&&v.length<=count&&v.every(x=>text(x,max));
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function publicSourceURL(value) {
  if (!text(value,2048)||/[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const u=new URL(value),h=u.hostname.toLowerCase().replace(/\.$/,'');
    if (u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)||
        /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(h)||
        [...u.searchParams.keys()].some(k=>/^(?:api[_-]?key|access[_-]?token|token|password|secret|authorization|credential)$/i.test(k))) return null;
    return u.href;
  } catch {return null;}
}

// An invalid extension cannot discard old messages, tasks, or an otherwise valid sync page.
export function safeRecommendation(value) {
  try {
    if (!record(value)||value.version!==1||!['hiking','general'].includes(value.kind)||
        !['ready','partial','unavailable'].includes(value.status)||!text(value.title,120)||!text(value.summary,1200)||
        value.timeWindow!==undefined&&!text(value.timeWindow,240)||!strings(value.constraints,300,12)||!text(value.nextStep,600)||
        !instant(value.retrievedAt)||!instant(value.validUntil)||
        !Array.isArray(value.sources)||value.sources.length>30||!Array.isArray(value.options)||value.options.length>3) return null;
    const seen=new Set(),sources=value.sources.map(s=>{
      if (!record(s)||!id(s.id)||seen.has(s.id)||!text(s.title,300)||!publicSourceURL(s.url)||
          !instant(s.retrievedAt)||!instant(s.expiresAt)||Date.parse(s.expiresAt)<Date.parse(s.retrievedAt)||
          s.publishedAt!==undefined&&!instant(s.publishedAt)) throw Error();
      seen.add(s.id);
      return {id:s.id,title:s.title,url:publicSourceURL(s.url),retrievedAt:s.retrievedAt,expiresAt:s.expiresAt,
        ...(s.publishedAt?{publishedAt:s.publishedAt}:{})};
    });
    const refs=ids=>Array.isArray(ids)&&ids.length<=30&&new Set(ids).size===ids.length&&ids.every(x=>seen.has(x));
    const optionIds=new Set(),options=value.options.map(o=>{
      if (!record(o)||!id(o.id)||optionIds.has(o.id)||!text(o.title,120)||!text(o.reason,600)||
          !['recommended','conditional','excluded'].includes(o.status)||!strings(o.conditions,300,12)||!strings(o.unknowns,300,12)||
          !refs(o.sourceIds)||!Array.isArray(o.facts)||o.facts.length>16||!Array.isArray(o.checks)||o.checks.length>2) throw Error();
      optionIds.add(o.id);
      const kinds=new Set();
      const checks=o.checks.map(c=>{
        if (!record(c)||!['access','weather'].includes(c.kind)||kinds.has(c.kind)||!['ok','risk','unknown'].includes(c.status)||
            !text(c.summary,600)||!refs(c.sourceIds)||c.status!=='unknown'&&!c.sourceIds.length) throw Error();
        kinds.add(c.kind);return {kind:c.kind,status:c.status,summary:c.summary,sourceIds:[...c.sourceIds]};
      });
      const facts=o.facts.map(f=>{
        if (!record(f)||!text(f.label,80)||!text(f.value,300)||!refs(f.sourceIds)||!f.sourceIds.length) throw Error();
        return {label:f.label,value:f.value,sourceIds:[...f.sourceIds]};
      });
      // Tighten presentation if the server ever sends an inconsistent safety state.
      const risk=checks.some(c=>c.status==='risk');
      const checked=checks.every(c=>c.status==='ok')&&(value.kind!=='hiking'||checks.length===2);
      const status=risk?'excluded':o.status==='recommended'&&(!checked||!o.sourceIds.length||o.unknowns.length)?'conditional':o.status;
      return {id:o.id,title:o.title,reason:o.reason,status,conditions:[...o.conditions],unknowns:[...o.unknowns],facts,checks,sourceIds:[...o.sourceIds]};
    });
    let status=value.status;
    if (status==='ready'&&(!sources.length||!options.some(o=>o.status==='recommended'))) status='partial';
    return {version:1,kind:value.kind,status,title:value.title,summary:value.summary,...(value.timeWindow?{timeWindow:value.timeWindow}:{}),
      constraints:[...value.constraints],options,sources,retrievedAt:value.retrievedAt,validUntil:value.validUntil,nextStep:value.nextStep};
  } catch {return null;}
}

const date=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function recommendationCard(value,{eventId='',feedback=true,now=Date.now()}={}) {
  const r=safeRecommendation(value);if (!r) return '';
  const expiredIds=new Set(r.sources.filter(s=>Date.parse(s.expiresAt)<=now).map(s=>s.id));
  const weatherIds=new Set(r.options.flatMap(o=>o.checks.filter(c=>c.kind==='weather').flatMap(c=>c.sourceIds)));
  const accessIds=new Set(r.options.flatMap(o=>o.checks.filter(c=>c.kind==='access').flatMap(c=>c.sourceIds)));
  const optionSources=o=>[...o.sourceIds,...o.facts.flatMap(f=>f.sourceIds),...o.checks.flatMap(c=>c.sourceIds)];
  const referencedIds=new Set(r.options.flatMap(optionSources));
  const unscopedExpired=[...expiredIds].some(id=>!referencedIds.has(id));
  const deadlineExpired=Date.parse(r.validUntil)<=now&&!r.sources.some(s=>Date.parse(s.expiresAt)===Date.parse(r.validUntil));
  const weatherExpired=[...expiredIds].some(id=>weatherIds.has(id));
  // validUntil is normally the earliest source expiry. Preserve its independent limit for old/no-source results.
  const expired=([...expiredIds].some(id=>!weatherIds.has(id)||accessIds.has(id)))||
    deadlineExpired;
  const stale=expired||weatherExpired;
  const checkExpired=c=>c.sourceIds.some(id=>expiredIds.has(id));
  const optionLabel=o=>{
    if(o.status==='excluded') return labels.excluded;
    if(optionSources(o).some(id=>expiredIds.has(id)&&(!weatherIds.has(id)||accessIds.has(id)))||
        deadlineExpired||unscopedExpired) return '需重新核实';
    if(optionSources(o).some(id=>expiredIds.has(id)&&weatherIds.has(id))) return '天气待更新';
    return labels[o.status];
  };
  const labels={recommended:'适合考虑',conditional:'需先确认',excluded:'暂不建议'};
  const sourceMap=new Map(r.sources.map((s,i)=>[s.id,{...s,n:i+1}]));
  const citations=ids=>ids.map(id=>{const s=sourceMap.get(id);return `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" aria-label="查看来源 ${s.n}：${esc(s.title)}">[${s.n}]</a>`;}).join(' ');
  const list=(title,items)=>items.length?`<p class="recommendation-label">${title}</p><ul>${items.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'';
  const options=r.options.map(o=>`<details class="recommendation-option" data-result-disclosure="option-${esc(o.id)}"><summary><strong>${esc(o.title)}</strong><span>${optionLabel(o)}</span></summary><p>${esc(o.reason)}</p>${o.facts.length?`<dl>${o.facts.map(f=>`<div><dt>${esc(f.label)}</dt><dd>${f.sourceIds.some(id=>expiredIds.has(id))?'上次资料（待更新）：':''}${esc(f.value)} ${citations(f.sourceIds)}</dd></div>`).join('')}</dl>`:''}${o.checks.map(c=>`<p class="recommendation-check ${c.status==='risk'?'risk':''}"><strong>${c.kind==='access'?'开放与预约':'天气与警报'}</strong> · ${checkExpired(c)?(c.kind==='weather'?'天气待更新':'需重新核实')+' · 上次核对：':''}${esc(c.summary)} ${citations(c.sourceIds)}</p>`).join('')}${list('出行条件',o.conditions)}${list('尚待确认',o.unknowns)}${o.sourceIds.length?`<p class="recommendation-links">路线依据 ${citations(o.sourceIds)}</p>`:''}</details>`).join('');
  const lastRetrieval=r.sources.length?new Date(Math.max(...r.sources.map(s=>Date.parse(s.retrievedAt)))).toISOString():r.retrievedAt;
  const sources=r.sources.length?`<details class="recommendation-sources" data-result-disclosure="sources"><summary>依据来源 · ${esc(date(lastRetrieval))} 检索</summary><ol>${r.sources.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a><span>检索于 ${esc(date(s.retrievedAt))}</span>${s.publishedAt?`<span>日期线索（待核实） ${esc(date(s.publishedAt))}</span>`:''}</li>`).join('')}</ol></details>`:`<p class="goal-note">${esc(date(r.retrievedAt))} 整理 · 暂无可验证来源</p>`;
  const summary=Array.from(r.summary).length>360
    ?`<div class="recommendation-intro">${readableResultText(resultPreview(r.summary,120))}</div><details class="recommendation-context" data-result-disclosure="intro"><summary>阅读完整方案说明</summary><div class="task-result-prose">${readableResultText(r.summary)}</div></details>`
    :`<div class="recommendation-intro">${readableResultText(r.summary)}</div>`;
  const constraints=r.constraints.length?`<details class="recommendation-context" data-result-disclosure="constraints"><summary>筛选条件</summary>${list('按这些条件筛选',r.constraints)}</details>`:'';
  return `<article class="recommendation-card" aria-label="${esc(r.title)}"><div class="recommendation-heading"><h2>${esc(r.title)}</h2><span>${expired?'资料已过期':weatherExpired?'天气待更新':r.status==='ready'?'推荐已就绪':r.status==='partial'?'部分信息待确认':'暂时无法推荐'}</span></div>${r.timeWindow?`<p class="goal-note">${esc(r.timeWindow)}</p>`:''}${stale?`<p class="recommendation-stale">${expired?'资料已过期，请在当前目标聊天中重新核实后再出行。':'天气待更新，路线候选保留；出发前请重新核实天气与生效警报。'}</p>`:''}<p class="recommendation-next"><strong>下一步</strong><br>${esc(r.nextStep)}</p>${summary}${options}${constraints}${sources}${feedback&&eventId?`<button class="agent-action" data-action="event-recommendation-feedback" data-event-id="${esc(eventId)}">聊聊这个方案</button>`:''}</article>`;
}
