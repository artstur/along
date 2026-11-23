// Product text only. This renderer grants no task, source or completion authority.
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const strict=(value,keys)=>record(value)&&Object.keys(value).every(key=>keys.includes(key));
const esc=value=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const RESULT_TEXT_LIMIT=16000;

export function safeResultPresentation(value) {
  try {
    if(!strict(value,['version','title','summary','actions','sections'])||value.version!==1||
      !text(value.title,120)||!text(value.summary,360)||!Array.isArray(value.actions)||value.actions.length>5||
      !Array.isArray(value.sections)||value.sections.length>6)return null;
    const actions=value.actions.map(action=>{
      if(!strict(action,['text','when'])||!text(action.text,240)||action.when!==undefined&&!text(action.when,120))throw Error();
      return {text:action.text.trim(),...(action.when!==undefined?{when:action.when.trim()}:{})};
    });
    const sections=value.sections.map(section=>{
      if(!strict(section,['heading','body'])||!text(section.heading,80)||!text(section.body,8000))throw Error();
      return {heading:section.heading.trim(),body:section.body.trim()};
    });
    const size=value.title.length+value.summary.length+
      value.actions.reduce((sum,item)=>sum+item.text.length+(item.when?.length??0),0)+
      value.sections.reduce((sum,item)=>sum+item.heading.length+item.body.length,0);
    if(size>RESULT_TEXT_LIMIT)return null;
    return {version:1,title:value.title.trim(),summary:value.summary.trim(),actions,sections};
  } catch {return null;}
}

// Recognize a small inert Markdown subset after escaping. Links and HTML never become active.
const inline=value=>value.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map(part=>part.startsWith('`')&&part.endsWith('`')
  ?`<code>${esc(part.slice(1,-1))}</code>`:part.startsWith('**')&&part.endsWith('**')
    ?`<strong>${esc(part.slice(2,-2))}</strong>`:esc(part)).join('');
const heading=line=>/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
const bullet=line=>/^\s*([-*+] |\d{1,9}[.)] )(.+)$/.exec(line);
const fence=line=>/^\s*(```+|~~~+)\s*[^\s]*\s*$/.exec(line);
const tableCells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim());
const tableRule=line=>line.includes('|')&&tableCells(line).every(cell=>/^:?-{3,}:?$/.test(cell));

export function readableResultText(value) {
  if(typeof value!=='string'||!value.trim())return '';
  const lines=value.replace(/\r\n?/g,'\n').split('\n'),blocks=[];
  for(let i=0;i<lines.length;) {
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    const code=fence(line);
    if(code){
      const content=[];i++;
      while(i<lines.length&&!new RegExp('^\\s*'+code[1][0]+`{${code[1].length},}\\s*$`).test(lines[i]))content.push(lines[i++]);
      if(i<lines.length)i++;
      blocks.push(`<pre><code>${esc(content.join('\n'))}</code></pre>`);continue;
    }
    const title=heading(line);
    if(title){blocks.push(`<h3>${inline(title[1])}</h3>`);i++;continue;}
    if(i+1<lines.length&&line.includes('|')&&tableRule(lines[i+1])) {
      const headers=tableCells(line),rows=[];i+=2;
      while(i<lines.length&&lines[i].trim()&&lines[i].includes('|'))rows.push(tableCells(lines[i++]));
      blocks.push(`<div class="task-result-table" role="region" aria-label="结果表格" tabindex="0"><table><thead><tr>${headers.map(cell=>`<th scope="col">${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);continue;
    }
    const item=bullet(line);
    if(item){
      const ordered=/^\d/.test(item[1]),tag=ordered?'ol':'ul',start=ordered?parseInt(item[1],10):1,items=[];
      while(i<lines.length){const next=bullet(lines[i]);if(!next||/^\d/.test(next[1])!==ordered)break;const n=ordered?parseInt(next[1],10):0;items.push(`<li${ordered&&n!==start+items.length?` value="${n}"`:''}>${inline(next[2])}</li>`);i++;}
      blocks.push(`<${tag}${ordered&&start!==1?` start="${start}"`:''}>${items.join('')}</${tag}>`);continue;
    }
    if(/^\s*>\s?/.test(line)){
      const quote=[];while(i<lines.length&&/^\s*>\s?/.test(lines[i]))quote.push(lines[i++].replace(/^\s*>\s?/,''));
      blocks.push(`<blockquote><p>${quote.map(inline).join('<br>')}</p></blockquote>`);continue;
    }
    const paragraph=[line];i++;
    while(i<lines.length&&lines[i].trim()&&!heading(lines[i])&&!bullet(lines[i])&&!fence(lines[i])&&
      !/^\s*>/.test(lines[i])&&!(i+1<lines.length&&lines[i].includes('|')&&tableRule(lines[i+1])))paragraph.push(lines[i++]);
    blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
  }
  return blocks.join('');
}

export function resultPreview(value,max=240) {
  if(typeof value!=='string')return '';
  const chars=Array.from(value.trim());
  return chars.length>max?chars.slice(0,max).join('')+'…':chars.join('');
}

export function taskResultCard(message) {
  if(!text(message?.text,RESULT_TEXT_LIMIT))return '';
  const body=readableResultText(message.text),p=safeResultPresentation(message.resultPresentation);
  if(p){
    const actions=p.actions.length?`<ol class="task-result-actions">${p.actions.map(action=>`<li>${action.when?`<span>${esc(action.when)}</span>`:''}${inline(action.text)}</li>`).join('')}</ol>`:'';
    const sections=p.sections.map((section,index)=>`<details class="task-result-explanation" data-result-disclosure="section-${index}"><summary>${esc(section.heading)}</summary><div class="task-result-prose">${readableResultText(section.body)}</div></details>`).join('');
    return `<article class="task-result-card"><h2>${esc(p.title)}</h2><p class="task-result-summary">${inline(p.summary)}</p>${actions}${sections}<details class="task-result-full" data-result-disclosure="full"><summary>阅读完整结果</summary><div class="task-result-prose">${body}</div></details></article>`;
  }
  const long=Array.from(message.text).length>600;
  return `<article class="task-result-card"><h2>执行结果</h2>${long?`<p class="task-result-preview-label">内容预览</p><div class="task-result-preview">${readableResultText(resultPreview(message.text))}</div><details class="task-result-full" data-result-disclosure="full"><summary>阅读完整结果</summary><div class="task-result-prose">${body}</div></details>`:`<div class="task-result-prose">${body}</div>`}</article>`;
}

export function captureResultReading(root,{activeElement,scrollY}={}) {
  const result=root.querySelector('.event-task-detail [id^="event-message-"]');
  if(!result?.id)return null;
  const details=[...result.querySelectorAll('details[data-result-disclosure]')];
  return {id:result.id,open:details.filter(item=>item.open).map(item=>item.dataset.resultDisclosure),
    focused:details.find(item=>item.querySelector('summary')===activeElement)?.dataset.resultDisclosure,
    scrollY:Number.isFinite(scrollY)?scrollY:undefined};
}

export function restoreResultReading(root,state,{scrollTo}={}) {
  if(!state)return false;
  const result=root.querySelector('.event-task-detail [id^="event-message-"]');
  if(result?.id!==state.id)return false;
  for(const detail of result.querySelectorAll('details[data-result-disclosure]')) {
    detail.open=state.open.includes(detail.dataset.resultDisclosure);
    if(state.focused===detail.dataset.resultDisclosure)detail.querySelector('summary')?.focus({preventScroll:true});
  }
  if(state.scrollY!==undefined)scrollTo?.({top:state.scrollY,behavior:'instant'});
  return true;
}
