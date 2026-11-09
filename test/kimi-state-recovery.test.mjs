import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync} from 'node:fs';
import {KimiCodeAgent} from '../host/kimi-code-agent.mjs';

function withState(contents) {
  const dir=mkdtempSync(join(tmpdir(),'along-kimi-state-'));
  const statePath=join(dir,'kimi-runs.json');
  if (contents!==null) writeFileSync(statePath,contents);
  return {dir,statePath,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

test('a truncated state file does not stop the agent host from starting',()=>{
  const state=withState('{"along-goal-health-a":{"kind":"goal"');
  try {
    // 构造时解析失败以前会直接把异常抛出去：宿主在模块顶层 new 这个类，
    // 于是整个 Along 服务起不来，用户在手机上什么都做不了。
    const agent=new KimiCodeAgent({statePath:state.statePath,token:'t',baseURL:'http://127.0.0.1:1'});
    assert.deepEqual(agent.runs,{},'坏掉的记录要按空记录继续');
  } finally { state.cleanup(); }
});

test('a state file holding null does not stop the agent host from starting',()=>{
  const state=withState('null');
  try {
    const agent=new KimiCodeAgent({statePath:state.statePath,token:'t',baseURL:'http://127.0.0.1:1'});
    assert.deepEqual(agent.runs,{},'null 要按空记录继续');
    agent.runs['along-goal-health-b']={kind:'goal'};
    agent.save();
  } finally { state.cleanup(); }
});

test('a state file holding a list does not stop the agent host from starting',()=>{
  const state=withState('[1,2,3]');
  try {
    const agent=new KimiCodeAgent({statePath:state.statePath,token:'t',baseURL:'http://127.0.0.1:1'});
    assert.deepEqual(agent.runs,{},'数组不是记录表，要按空记录继续');
  } finally { state.cleanup(); }
});

test('a valid state file is still read',()=>{
  const state=withState(JSON.stringify({'along-goal-health-c':{kind:'goal',sessionId:'s1'}}));
  try {
    const agent=new KimiCodeAgent({statePath:state.statePath,token:'t',baseURL:'http://127.0.0.1:1'});
    assert.equal(agent.runs['along-goal-health-c'].sessionId,'s1','好的记录不能被丢掉');
  } finally { state.cleanup(); }
});

test('the state file is replaced atomically so a killed process cannot truncate it',()=>{
  const state=withState(null);
  try {
    const agent=new KimiCodeAgent({statePath:state.statePath,token:'t',baseURL:'http://127.0.0.1:1'});
    agent.runs['along-goal-health-d']={kind:'goal'};
    agent.save();
    const saved=JSON.parse(readFileSync(state.statePath,'utf8'));
    assert.equal(saved['along-goal-health-d'].kind,'goal');
    assert.ok(!existsSync(`${state.statePath}.tmp`),'临时文件要已经改成正式文件，不能留在盘上');
  } finally { state.cleanup(); }
});
