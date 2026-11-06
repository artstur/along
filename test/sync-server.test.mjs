import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHealthSyncServer,validateHealthSummary} from '../host/sync-server.mjs';

const summary={schema:1,source:'healthkit',selectedTypes:['steps','workout'],capturedAt:'2026-11-03T10:00:00.000Z',snapshot:{steps:6520,workoutMinutes:75,workoutCount:2}};

test('only selected aggregate fields are accepted',()=>{
  assert.deepEqual(validateHealthSummary(summary).snapshot,summary.snapshot);
  assert.throws(()=>validateHealthSummary({...summary,snapshot:{...summary.snapshot,weightKg:63.2}}),/未选择/);
  assert.throws(()=>validateHealthSummary({...summary,snapshot:{steps:6520,workoutMinutes:75}}),/不完整/);
});

test('pairing gates sync; read-back stores only summary and delete removes it',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'along-health-test-'));
  const {server}=createHealthSyncServer({dataDir,pairCode:'12345678'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const send=(path,method,body,token)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  try {
    assert.equal((await send('/api/health-sync','POST',summary)).status,401);
    assert.equal((await send('/api/pair','POST',{code:'wrong'})).status,403);
    const paired=await (await send('/api/pair','POST',{code:'12345678'})).json();
    assert.match(paired.token,/^[a-f0-9]{64}$/);
    assert.equal((await send('/api/health-sync','POST',summary,paired.token)).status,200);
    const saved=await (await send('/api/health-sync','GET',null,paired.token)).json();
    assert.deepEqual(saved.summary.snapshot,summary.snapshot);
    assert.equal(saved.summary.snapshot.weightKg,undefined);
    assert.equal((await send('/api/health-sync','DELETE',null,paired.token)).status,200);
    assert.equal((await (await send('/api/health-sync','GET',null,paired.token)).json()).summary,null);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await rm(dataDir,{recursive:true,force:true});
  }
});
