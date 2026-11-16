import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

test('local and APNs due alerts withdraw by bound task revision regardless of OS request identifier',()=>{
  const swift=readFileSync(new URL('../ios/AlongHealth/Sources/EventTaskNotifications.swift',import.meta.url),'utf8');
  const fn=swift.match(/    static func withdrawn\([\s\S]*?\n    }/);
  assert.ok(fn);
  const program=`import Foundation
enum Rule {
${fn[0]}
}
for kind in ["reminder","reminder_due"] {
    let route: [String:Any] = ["kind":kind,"userId":"first","goalId":"goal","taskId":"task","revision":2]
    precondition(!Rule.withdrawn(route,user:"first",allowed:true,openTasks:["goal:task":2]))
    precondition(Rule.withdrawn(route,user:"first",allowed:true,openTasks:["goal:task":3]))
    precondition(Rule.withdrawn(route,user:"first",allowed:true,openTasks:[:]))
    precondition(Rule.withdrawn(route,user:"second",allowed:true,openTasks:["goal:task":2]))
    precondition(Rule.withdrawn(route,user:"first",allowed:false,openTasks:["goal:task":2]))
}`;
  const run=spawnSync('swift',['-'],{input:program,encoding:'utf8'});
  if (run.error?.code!=='ENOENT') assert.equal(run.status,0,run.stderr);
});
