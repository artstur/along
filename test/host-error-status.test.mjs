import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {HostError, upstream, statusForError} from '../host/host-error.mjs';

const hostSource=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');
const serverSource=readFileSync(new URL('../host/server.mjs',import.meta.url),'utf8');

// 错误分类放在共享的 host/host-error.mjs 里：Agent 宿主与本地服务都要用同一套，
// 两边对「上游挂了」和「我发错了」的判断不能分叉。这里直接 import 真正发布的那份。
test('an upstream failure is answered as a server-side problem, not as a bad request',async()=>{
  const failure=await upstream(()=>{throw Error('Kimi Code Web Server 未运行：fetch failed');}).catch(error=>error);
  assert.equal(statusForError(failure),502,'上游故障要答复 5xx，不能是 400');
  assert.match(failure.message,/未运行/,'答复给用户的消息不能变');
  assert.equal(statusForError(new HostError('DSH Super Agent 未运行',503)),503);
  assert.equal(statusForError(await upstream(()=>{throw new HostError('DSH 未就绪',503);}).catch(error=>error)),503,'已有的上游状态码要保留');
});

test('a bad request and a busy host keep their own status',()=>{
  assert.equal(statusForError(new Error('请求过大')),400,'客户端发错了仍然是 400');
  assert.equal(statusForError(new Error('目标名称无效')),400);
  assert.equal(statusForError(new Error('Along 正在处理上一条请求，请稍后再试')),429,'宿主忙着仍然是 429');
});

test('both host entry points answer an upstream failure with a server-side status',()=>{
  assert.match(serverSource,/statusForError\(error\)/,'本地服务要按同一套判断答复状态码');
  assert.match(serverSource,/upstream\(\(\)=>proposeNextStep\(/,'上游调用必须包在 upstream() 里，否则故障会被当成客户端请求不合法');
  assert.doesNotMatch(serverSource,/json\(res,400,/,'本地服务不能再把上游故障答成 400');
});

// 判断某个调用点是不是落在 upstream(...) 包装里：向外逐层找出包裹它的调用。
function insideUpstream(text,index) {
  let depth=0; const heads=[];
  for (let i=index-1;i>=0;i-=1) {
    const ch=text[i];
    if (ch===')') depth++;
    else if (ch==='(') {
      if (depth>0) { depth-=1; continue; }
      heads.push(text.slice(Math.max(0,i-32),i));
    }
  }
  return heads.some(head=>/upstream\s*$/.test(head));
}

function callsIn(routes,pattern) {
  const found=[];
  for (const match of routes.matchAll(pattern)) {
    found.push({index:match.index,text:routes.slice(Math.max(0,match.index-40),match.index+match[0].length).replace(/\s+/g,' '),inside:insideUpstream(routes,match.index)});
  }
  return found;
}

test('no upstream call in the routes escapes the upstream wrapper',()=>{
  const start=hostSource.indexOf('const server=createServer');
  const end=hostSource.indexOf('server.listen(');
  assert.ok(start>0&&end>start,'找不到宿主的路由处理');
  const routes=hostSource.slice(start,end);
  const missed=callsIn(routes,/(kimiAgent\.\w+\(|superAgentCall\(|superAgentReady\(|runTaskCodex\(|validateTaskReply\(|normalizeGoalRun\()/g)
    .filter(call=>!call.inside);
  assert.deepEqual(missed.map(call=>call.text),[],'上游调用必须包在 upstream() 里，否则故障会被当成客户端请求不合法');
  assert.match(routes,/statusForError\(error\)/,'答复状态码要走同一套判断');
  // 反过来：客户端自己的校验不能被包进上游，否则「我发错了」也会被答成 5xx。
  const misfiled=callsIn(routes,/(requestId\(|cleanGoal\(|cleanSnapshot\()/g)
    .filter(call=>call.inside);
  assert.deepEqual(misfiled.map(call=>call.text),[],'客户端入参校验必须在包上游之前，否则非法请求会被答成 5xx');
});
