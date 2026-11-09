import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const hostSource=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');

// 从真实发布的宿主源码里取出这段错误分类，拿到独立上下文里跑：
// 断言的是宿主里真正在跑的那份逻辑，不是照抄一份。
function loadHostErrors() {
  const start=hostSource.indexOf('class HostError');
  const end=hostSource.indexOf('async function body(');
  assert.ok(start>0&&end>start,'找不到宿主的错误分类');
  const context=vm.createContext({});
  vm.runInContext(`${hostSource.slice(start,end)}\nglobalThis.api={HostError,upstream,statusForError};`,context);
  return context.api;
}

test('an upstream failure is answered as a server-side problem, not as a bad request',async()=>{
  const {HostError,upstream,statusForError}=loadHostErrors();
  const failure=await upstream(()=>{throw Error('Kimi Code Web Server 未运行：fetch failed');}).catch(error=>error);
  assert.equal(statusForError(failure),502,'上游故障要答复 5xx，不能是 400');
  assert.match(failure.message,/未运行/,'答复给用户的消息不能变');
  assert.equal(statusForError(new HostError('DSH Super Agent 未运行',503)),503);
  assert.equal(statusForError(await upstream(()=>{throw new HostError('DSH 未就绪',503);}).catch(error=>error)),503,'已有的上游状态码要保留');
});

test('a bad request and a busy host keep their own status',()=>{
  const {statusForError}=loadHostErrors();
  assert.equal(statusForError(new Error('请求过大')),400,'客户端发错了仍然是 400');
  assert.equal(statusForError(new Error('目标名称无效')),400);
  assert.equal(statusForError(new Error('Along 正在处理上一条请求，请稍后再试')),429,'宿主忙着仍然是 429');
});

test('no upstream call in the routes escapes the upstream wrapper',()=>{
  const start=hostSource.indexOf('const server=createServer');
  const end=hostSource.indexOf('server.listen(');
  assert.ok(start>0&&end>start,'找不到宿主的路由处理');
  const routes=hostSource.slice(start,end);
  const primitives=/(kimiAgent\.\w+\(|superAgentCall\(|superAgentReady\(|runTaskCodex\(|validateTaskReply\(|normalizeGoalRun\()/g;
  const missed=[];
  for (const match of routes.matchAll(primitives)) {
    const before=routes.slice(Math.max(0,match.index-24),match.index);
    if (!before.endsWith('upstream(()=>')) missed.push(routes.slice(match.index-30,match.index+match[0].length).replace(/\s+/g,' '));
  }
  assert.deepEqual(missed,[],'上游调用必须包在 upstream() 里，否则故障会被当成客户端请求不合法');
  assert.match(routes,/statusForError\(error\)/,'答复状态码要走同一套判断');
});
