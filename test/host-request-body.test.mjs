import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readJsonBody} from '../host/request-body.mjs';

const agentHostSource=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');
const serverSource=readFileSync(new URL('../host/server.mjs',import.meta.url),'utf8');

// 把一段 UTF-8 正文从某个多字节字符的中间切开，模拟 TCP 分段。
function splitInsideCharacter(text) {
  const payload=Buffer.from(text,'utf8');
  for (let index=1;index<payload.length;index++) {
    // 续字节（10xxxxxx）说明这个位置落在多字节字符中间。
    if ((payload[index]&0xc0)===0x80) return [payload.subarray(0,index),payload.subarray(index)];
  }
  throw Error('这段正文里没有多字节字符');
}
async function* stream(chunks) { for (const chunk of chunks) yield chunk; }

test('a body split inside a chinese character is decoded as one character',async()=>{
  const message='本周运动 120 分钟';
  const parsed=await readJsonBody(stream(splitInsideCharacter(JSON.stringify({message}))),32_000);
  assert.equal(parsed.message,message,'跨块的中文不能被切坏成乱码');
});

test('a body that arrives in one piece still decodes',async()=>{
  const message='本周运动 120 分钟';
  const payload=Buffer.from(JSON.stringify({message}),'utf8');
  const parsed=await readJsonBody(stream([payload]),32_000);
  assert.equal(parsed.message,message);
});

test('an oversized body is still refused',async()=>{
  const payload=Buffer.from(JSON.stringify({message:'长'.repeat(100)}),'utf8');
  await assert.rejects(()=>readJsonBody(stream([payload]),16),/请求过大/,'超大的请求体要被拒绝');
});

test('a long chinese conversation is not refused as too large',async()=>{
  // 上限按字符算：中文一个字是三个字节，按字节算会让一次正常的中文长对话
  // （12 条历史 + 正文，最多几万字）被判「请求过大」。
  const message='本'.repeat(15_000);
  const payload=Buffer.from(JSON.stringify({message}),'utf8');
  const parsed=await readJsonBody(stream([payload]),32_000);
  assert.equal(parsed.message.length,15_000,'中文长对话不该被判「请求过大」');
});

test('both host entry points read the body with the shared reader',()=>{
  assert.match(agentHostSource,/readJsonBody\(req,32_000\)/,'Agent 宿主要用共享的读体实现');
  assert.match(serverSource,/readJsonBody\(req,8192\)/,'本地服务要用共享的读体实现');
  assert.doesNotMatch(agentHostSource,/text\+=chunk/,'不能再逐块 toString');
  assert.doesNotMatch(serverSource,/raw\+=part/,'不能再逐块 toString');
});
