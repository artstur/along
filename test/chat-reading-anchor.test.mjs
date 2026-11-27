import test from 'node:test';
import assert from 'node:assert/strict';
import {captureChatAnchor, anchoredScrollTop} from '../web/event-workspace.mjs';

// 锚点逻辑只用到这几个接口，用假的气泡和滚动容器就能覆盖，不用真浏览器。
const bubble=(id,top,bottom)=>({dataset:{eventId:id},getBoundingClientRect:()=>({top,bottom})});
const scroller=({bubbles=[],scrollTop=0,scrollHeight=3000,clientHeight=800,boxTop=0})=>({
  scrollTop,scrollHeight,clientHeight,
  getBoundingClientRect:()=>({top:boxTop,bottom:boxTop+clientHeight}),
  querySelectorAll:()=>bubbles,
});

test('the anchor is the first bubble that starts inside the viewport',()=>{
  const box=scroller({bubbles:[
    bubble('m0',-900,-700),   // 完全在视口上方
    bubble('m1',-300,-100),   // 完全在视口上方
    bubble('m9',-24,108),     // 只露出一条边，已经在被读过去
    bubble('m10',120,320),    // 读者正在看的那条
    bubble('m11',340,540),
  ]});
  assert.deepEqual(captureChatAnchor(box),{id:'m10',offset:120});
});

test('a bubble without an event id is never used as the anchor',()=>{
  const waiting={dataset:{},getBoundingClientRect:()=>({top:10,bottom:60})};
  const box=scroller({bubbles:[waiting,bubble('m10',120,320)]});
  assert.deepEqual(captureChatAnchor(box),{id:'m10',offset:120});
  assert.equal(captureChatAnchor(scroller({bubbles:[waiting]})),null);
  assert.equal(captureChatAnchor(null),null);
});

test('content inserted above the reading bubble keeps that bubble in place',()=>{
  // 读者把第 11 条气泡放在消息区顶部下方 120px，滚动位置 1969。
  const anchor=captureChatAnchor(scroller({bubbles:[bubble('m0',-900,-700),bubble('m10',120,320)],scrollTop:1969}));
  assert.deepEqual(anchor,{id:'m10',offset:120});
  // 历史回放补时间，在阅读位置上方插入 27 条分割线：气泡在内容里下移 418px。
  // 重渲染后是新的滚动容器，scrollTop 从 0 起算，气泡的内容位置是 2089+418=2507。
  const next=scroller({bubbles:[bubble('m0',-1318,-1118),bubble('m10',2507,2707)],scrollTop:0,scrollHeight:3418});
  const top=anchoredScrollTop(next,anchor);
  assert.equal(top,2387,'滚动量要补上上方插入的内容高度');
  // 复位后气泡回到同一个视口位置。
  assert.equal(2507-top,120);
});

test('nothing inserted above the reading bubble leaves the scroll where it was',()=>{
  const anchor=captureChatAnchor(scroller({bubbles:[bubble('m10',120,320)],scrollTop:1969}));
  const next=scroller({bubbles:[bubble('m10',2089,2289)],scrollTop:0,scrollHeight:3000});
  assert.equal(anchoredScrollTop(next,anchor),1969);
});

test('a missing anchor leaves the scroll to the caller',()=>{
  const anchor=captureChatAnchor(scroller({bubbles:[bubble('m10',120,320)]}));
  assert.equal(anchoredScrollTop(scroller({bubbles:[bubble('m11',120,320)]}),anchor),null);
  assert.equal(anchoredScrollTop(scroller({bubbles:[]}),anchor),null);
  assert.equal(anchoredScrollTop(scroller({bubbles:[bubble('m10',120,320)]}),null),null);
});

test('the anchored scroll never leaves the scrollable range',()=>{
  const anchor=captureChatAnchor(scroller({bubbles:[bubble('m10',120,320)],scrollTop:1969}));
  // 内容变短时不能越过底部。
  const short=scroller({bubbles:[bubble('m10',120,320)],scrollTop:0,scrollHeight:800,clientHeight:800});
  assert.equal(anchoredScrollTop(short,anchor),0);
});
