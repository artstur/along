import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerDailyGrant,findDailyGrant} from '../host/daily-delegation.mjs';
test('a Mac instruction can only be claimed by its paired phone with the prior receipt in the same goal',()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-grant-'));
  const pair='a'.repeat(64),anchor='prior-scope-proof';
  const grant={goalKey:'health',id:'delegation',topics:['sleep','workout'],weeklyWorkoutMinutes:120,requestId:'new-request',ticketId:'real-ticket'};
  try {
    registerDailyGrant(dir,pair,anchor,grant,1000);
    assert.deepEqual(findDailyGrant(dir,pair,'health',[anchor],2000),grant);
    for (const [p,g,a,t] of [[pair,'custom:another',[anchor],2000],['b'.repeat(64),'health',[anchor],2000],[pair,'health',['other-id'],2000],[pair,'health',[anchor],1000+36*3600000]])
      assert.equal(findDailyGrant(dir,p,g,a,t),null);
    assert.throws(()=>registerDailyGrant(dir,pair,anchor,{...grant,topics:['weight']}));
    assert.throws(()=>findDailyGrant(dir,pair,'health',['../pairing.json']));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
