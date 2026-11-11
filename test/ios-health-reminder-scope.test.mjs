import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const source=readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
test('adopting a plan only replaces reminders owned by that goal, including legacy reminders',()=>{
  const prefix=source.match(/        private static func healthReminderPrefix\([\s\S]+?\n        }/);
  assert.ok(prefix,'missing goal-specific notification scope');
  const hash=source.match(/        private static func notificationIdentifier\([\s\S]+?\n        }/);
  const program=`import CryptoKit
import Foundation
enum Scope {
${hash[0]}
${prefix[0]}
    static func verify() {
        let old = healthReminderPrefix("health") + notificationIdentifier("walk")
        precondition(old.hasPrefix("along.health-plan."))
        let a = healthReminderPrefix("custom:first") + notificationIdentifier("walk")
        let b = healthReminderPrefix("custom:second") + notificationIdentifier("walk")
        precondition(!a.hasPrefix(healthReminderPrefix("health")))
        precondition(!b.hasPrefix(healthReminderPrefix("custom:first")))
        precondition(!old.hasPrefix(healthReminderPrefix("custom:first")))
    }
}
Scope.verify()`;
  const swift=spawnSync('swift',['-'],{input:program,encoding:'utf8'});
  if (swift.error?.code!=='ENOENT') assert.equal(swift.status,0,swift.stderr);
  assert.match(source,/let prefix = healthReminderPrefix\(goalKey\)/);
  assert.match(source,/content.userInfo = \["kind": "task", "goalKey": goalKey/);
});
