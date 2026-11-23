import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {KimiCodeAgent,localKimiMigration} from '../host/kimi-code-agent.mjs';

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

test('a legacy Mac run is restored under the known owner only and never replaces a current run',async()=>{
  const legacy=withState(JSON.stringify({
    'req-old':{kind:'goal',sessionId:'legacy-session',input:{requestId:'req-old'}},
    'req-current':{kind:'task',sessionId:'stale-session',input:{requestId:'req-current'}},
  }));
  const userId='u_1234abcd';
  const current=withState(JSON.stringify({
    [`${userId}:req-current`]:{kind:'task',sessionId:'current-session'},
  }));
  try {
    const seen=[];
    const options={statePath:current.statePath,legacyStatePath:legacy.statePath,legacyUserId:userId,
      token:'fixture',fetchImpl:async url=>{seen.push(new URL(url).pathname);throw Error('fixture Kimi offline');}};
    const agent=new KimiCodeAgent(options);
    await assert.rejects(agent.goalStatus(userId,'req-old'),/fixture Kimi offline/);
    assert.ok(seen.includes('/api/v1/sessions/legacy-session'));
    await assert.rejects(agent.goalStatus('u_aaaaaaaa','req-old'),/运行记录不存在/);
    const saved=JSON.parse(readFileSync(current.statePath,'utf8'));
    assert.equal(saved[`${userId}:req-old`].sessionId,'legacy-session');
    assert.equal(saved[`${userId}:req-current`].sessionId,'current-session');
    writeFileSync(legacy.statePath,JSON.stringify({
      'req-old':{kind:'goal',sessionId:'stale-on-restart',input:{requestId:'req-old'}},
    }));
    assert.deepEqual(new KimiCodeAgent(options).runs,saved);
  } finally { current.cleanup();legacy.cleanup(); }
});

test('the two Mac entry points only adopt a shared legacy ledger with one known owner',t=>{
  const home=mkdtempSync(join(tmpdir(),'along-kimi-home-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const direct=join(home,'.along','agent-host'),activated=join(home,'.along','phone-test','host');
  for (const dir of [direct,activated]) mkdirSync(dir,{recursive:true});
  const alice={user_id:'u_1234abcd'},bob={user_id:'u_a1234bcd'};
  const legacy={legacyUserId:alice.user_id,legacyStatePath:join(direct,'kimi-runs.json')};
  assert.deepEqual(localKimiMigration(activated,[alice],home),legacy);
  assert.deepEqual(localKimiMigration(direct,[alice],home),legacy);
  assert.deepEqual(localKimiMigration(activated,[],home),{});
  assert.deepEqual(localKimiMigration(activated,[alice,bob],home),{});
  assert.deepEqual(localKimiMigration(join(home,'custom-host'),[alice],home),{});
  writeFileSync(join(direct,'pairing.json'),JSON.stringify(bob));
  writeFileSync(join(activated,'pairings.json'),JSON.stringify([alice]));
  assert.deepEqual(localKimiMigration(activated,[alice],home),{});
  assert.deepEqual(localKimiMigration(direct,[bob],home),{});
  writeFileSync(join(direct,'pairings.json'),JSON.stringify([alice]));
  assert.deepEqual(localKimiMigration(activated,[alice],home),legacy);
});
