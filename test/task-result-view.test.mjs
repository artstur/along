import test from 'node:test';
import assert from 'node:assert/strict';
import {safeResultPresentation,readableResultText,taskResultCard,resultPreview,RESULT_TEXT_LIMIT,captureResultReading,restoreResultReading} from '../web/task-result-view.mjs';

const presentation=()=>({version:1,title:'今日安排',summary:'先完成一个小步骤。',actions:[{text:'准备休息',when:'今晚'}],
  sections:[{heading:'为什么这样安排',body:'保留完整说明。'}]});

test('the optional display contract is strict, bounded and does not invent values from malformed text',()=>{
  assert.deepEqual(safeResultPresentation(presentation()),presentation());
  for(const bad of [null,[],{},'text',{...presentation(),version:2},{...presentation(),title:{}},
    {...presentation(),summary:' '},{...presentation(),summary:'字'.repeat(361)},
    {...presentation(),actions:Array(6).fill({text:'a'})},{...presentation(),sections:Array(7).fill({heading:'x',body:'y'})},
    {...presentation(),actions:[{text:'a',url:'https://example.com'}]},
    {...presentation(),sections:[{heading:'x',body:'y',html:'<b>bad</b>'}]},
    {...presentation(),sources:[]}, {...presentation(),sections:[{heading:'x',body:'字'.repeat(8001)}]},
    {...presentation(),sections:[{heading:'x',body:'字'.repeat(8000)},{heading:'y',body:'字'.repeat(8000)}]}])assert.equal(safeResultPresentation(bad),null);
});

test('text blocks remain inert while headings, ordered steps, quotes and code become readable',()=>{
  const html=readableResultText('## 本次安排\n\n**先做一件事**\n\n1. 一步\n2. 两步\n\n> 这是依据\n\n```text\n<script>alert(1)</script>\n```\n\n[链接](javascript:alert(1))');
  assert.match(html,/<h3>本次安排<\/h3>/);assert.match(html,/<strong>先做一件事<\/strong>/);
  assert.match(html,/<ol><li>一步<\/li><li>两步<\/li><\/ol>/);assert.match(html,/<blockquote>/);
  assert.match(html,/<pre><code>&lt;script&gt;/);assert.doesNotMatch(html,/<script|<a |onclick|onerror/);
  assert.match(html,/\[链接\]\(javascript:alert\(1\)\)/);
  assert.match(readableResultText('3. 保留编号\n4. 继续'),/<ol start="3">/);
  assert.match(readableResultText('1. 原编号\n3. 跳号保留'),/<li value="3">跳号保留/);
  assert.match(readableResultText('`**这不是加粗**`'),/<code>\*\*这不是加粗\*\*<\/code>/);
});

test('tables and unclosed fences preserve their final values without activating model HTML',()=>{
  const table=readableResultText('| 项目 | 结果 |\n| --- | --- |\n| <img src=x> | 最后一项 |');
  assert.match(table,/role="region" aria-label="结果表格" tabindex="0"/);
  assert.match(table,/<th scope="col">项目/);assert.match(table,/&lt;img src=x&gt;/);assert.match(table,/最后一项/);
  assert.doesNotMatch(table,/<img/);
  assert.match(readableResultText('~~~\n末尾没有结束围栏'),/末尾没有结束围栏<\/code><\/pre>/);
});

test('long legacy bodies expose a labeled preview and keep every character available in full reading',()=>{
  const body='甲'.repeat(600)+'\n\n'+'😀'.repeat(120)+'\n\n真正的最后一行。';
  const html=taskResultCard({text:body});
  assert.match(html,/内容预览/);assert.match(html,/<summary>阅读完整结果<\/summary>/);
  assert.match(html,/真正的最后一行。/);assert.ok(html.includes('😀'.repeat(120)));
  assert.equal(resultPreview('😀😀😀',2),'😀😀…');
  assert.equal(taskResultCard({text:'字'.repeat(RESULT_TEXT_LIMIT+1)}),'');
});

test('structured brief and actions never replace the full result or activate untrusted text',()=>{
  const p=presentation();p.title='<img src=x>';p.actions[0].text='<script>bad()</script>';
  const html=taskResultCard({text:'完整来源正文的末尾。',resultPresentation:p});
  assert.match(html,/&lt;img src=x&gt;/);assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html,/完整来源正文的末尾。/);assert.match(html,/为什么这样安排/);
  assert.doesNotMatch(html,/<img|<script/);
  const fallback=taskResultCard({text:'保留旧正文',resultPresentation:{...p,version:3}});
  assert.match(fallback,/保留旧正文/);assert.doesNotMatch(fallback,/准备休息/);
});

test('a sync redraw preserves expanded sections, keyboard focus and scroll only for the same result',()=>{
  const detail=(key,open)=>{const summary={focused:false,focus(){this.focused=true;}};return {dataset:{resultDisclosure:key},open,querySelector:()=>summary,summary};};
  const before=[detail('section-0',false),detail('full',true)],after=[detail('section-0',false),detail('full',false)];
  let result={id:'event-message-same',querySelectorAll:()=>before};const root={querySelector:()=>result};
  const reading=captureResultReading(root,{activeElement:before[1].summary,scrollY:1200});
  result={id:'event-message-same',querySelectorAll:()=>after};let scroll;
  assert.equal(restoreResultReading(root,reading,{scrollTo:value=>{scroll=value;}}),true);
  assert.equal(after[1].open,true);assert.equal(after[0].open,false);assert.equal(after[1].summary.focused,true);assert.equal(scroll.top,1200);
  after[1].open=false;after[1].summary.focused=false;result.id='event-message-another';
  assert.equal(restoreResultReading(root,reading),false);assert.equal(after[1].open,false);assert.equal(after[1].summary.focused,false);
  assert.equal(captureResultReading({querySelector:()=>null}),null);
});
