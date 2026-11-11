import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const reader=readFileSync(new URL('../ios/AlongHealth/Sources/HealthKitReader.swift',import.meta.url),'utf8');
const shell=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
test('background delivery requires the native goal, grant, template version and original Mac',()=>{
 const start=reader.indexOf('enum BackgroundReviewAdmission {'),end=reader.indexOf('// Protected, app-local',start);
 assert.ok(start>=0&&end>start);
 const dir=mkdtempSync(join(tmpdir(),'along-bg-admission-'));
 try{
  const file=join(dir,'Check.swift');
  writeFileSync(file,'import Foundation\n'+reader.slice(start,end)+`
let t:[String:Any]=["goalKey":"health","version":"v1","runtime":"dsh-superagent","selectedTypes":["sleep","workout"],"comparisonHistoryAllowed":false,"planning":["kind":"context-review","version":1],"goal":["domain":"health","title":"我的健康目标"]]
let previous:[String:Any]=["template":t,"pair":"pair-1","pending":["state":"uncertain","requestId":"along-review-1"]]
precondition(BackgroundReviewAdmission.valid(t, goalKey:"health"))
precondition(!BackgroundReviewAdmission.valid(t, goalKey:"custom:x"))
precondition(BackgroundReviewAdmission.matches(previous,template:t,pair:"pair-1"))
precondition(!BackgroundReviewAdmission.matches(previous,template:t,pair:"pair-2"))
precondition(!BackgroundReviewAdmission.matches(previous,template:t.merging(["version":"v2"]){_,n in n},pair:"pair-1"))
precondition(!BackgroundReviewAdmission.valid(t.merging(["runtime":"kimi-code-swarm"]){_,n in n},goalKey:"health"))
precondition(!BackgroundReviewAdmission.valid(t.merging(["token":"never"]){_,n in n},goalKey:"health"))
`);
  const result=spawnSync('swift',[file],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('the native path starts before the web view and persists an id before sending work',()=>{
 assert.match(shell,/UIApplicationDelegateAdaptor/);
 assert.match(reader,/enableBackgroundDelivery/);
 assert.match(reader,/disableBackgroundDelivery/);
 assert.match(reader,/completeFileProtection/);
 assert.match(reader,/buildBackgroundReviewRequest/);
 assert.match(reader,/agentRequest\(/);
 assert.match(shell,/backgroundReviewGoalKey/);
});
