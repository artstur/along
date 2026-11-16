import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

test('native recurrence honors the Agent timezone, start date and ISO weekday without introducing earlier notifications',()=>{
  const swift=readFileSync(new URL('../ios/AlongHealth/Sources/EventTaskNotifications.swift',import.meta.url),'utf8');
  const fn=swift.match(/    static func reminderTiming\([\s\S]*?\n    }/);
  assert.ok(fn,'recurrence must be implemented in the native scheduling path');
  const program=`import Foundation
enum Rule {
${fn[0]}
}
func date(_ value:String)->Date { ISO8601DateFormatter().date(from:value)! }
let now=date("2026-11-16T14:00:00Z")
let daily=Rule.reminderTiming(date:date("2026-11-16T17:30:00Z"),rule:"daily",timezone:"Asia/Shanghai",weekday:nil,wallTime:nil,now:now)!
precondition(daily.repeats && daily.parts.hour == 1 && daily.parts.minute == 30 && daily.parts.day == nil)
precondition(daily.parts.timeZone?.identifier == "Asia/Shanghai")
let weekly=Rule.reminderTiming(date:date("2026-11-16T14:30:00Z"),rule:"weekly",timezone:"Asia/Shanghai",weekday:1,wallTime:nil,now:now)!
precondition(weekly.repeats && weekly.parts.weekday == 2 && weekly.parts.hour == 22)
let sunday=Rule.reminderTiming(date:date("2026-11-22T14:30:00Z"),rule:"weekly",timezone:"Asia/Shanghai",weekday:7,wallTime:nil,now:now)!
precondition(sunday.repeats && sunday.parts.weekday == 1)
let laterStart=Rule.reminderTiming(date:date("2026-11-23T14:30:00Z"),rule:"weekly",timezone:"Asia/Shanghai",weekday:1,wallTime:nil,now:now)!
precondition(!laterStart.repeats && laterStart.parts.year == 2026 && laterStart.parts.day == 23)
let lateDaily=Rule.reminderTiming(date:date("2026-11-18T17:30:00Z"),rule:"daily",timezone:"Asia/Shanghai",weekday:nil,wallTime:nil,now:now)!
precondition(!lateDaily.repeats)
let elapsed=Rule.reminderTiming(date:date("2026-11-15T17:30:00Z"),rule:"daily",timezone:"Asia/Shanghai",weekday:nil,wallTime:nil,now:now)!
precondition(elapsed.repeats && elapsed.parts.hour == 1)
let legacy=Rule.reminderTiming(date:date("2026-11-16T17:30:00Z"),rule:nil,timezone:nil,weekday:nil,wallTime:nil,now:now)!
precondition(!legacy.repeats && legacy.parts.date == date("2026-11-16T17:30:00Z"))
precondition(Rule.reminderTiming(date:now,rule:"daily",timezone:"Planet/Mars",weekday:nil,wallTime:nil,now:now) == nil)
precondition(Rule.reminderTiming(date:now,rule:"weekly",timezone:"Asia/Shanghai",weekday:0,wallTime:nil,now:now) == nil)
precondition(Rule.reminderTiming(date:now,rule:"daily",timezone:"Asia/Shanghai",weekday:2,wallTime:nil,now:now) == nil)
precondition(Rule.reminderTiming(date:now,rule:"monthly",timezone:"Asia/Shanghai",weekday:nil,wallTime:nil,now:now) == nil)
// Preserve the original civil clock even when the first occurrence shifted through a DST gap.
let gap=Rule.reminderTiming(date:date("2026-03-08T07:30:00Z"),rule:"daily",timezone:"America/New_York",weekday:nil,
  wallTime:date("2026-03-07T07:30:00Z"),now:date("2026-03-08T06:00:00Z"))!
precondition(gap.repeats && gap.parts.hour == 2 && gap.parts.minute == 30)
`;
  const run=spawnSync('swift',['-'],{input:program,encoding:'utf8'});
  if (run.error?.code!=='ENOENT') assert.equal(run.status,0,run.stderr);
});

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

test('native repeated reconciliations reuse an identical recurring request and replace changed clocks or task versions',()=>{
  const swift=readFileSync(new URL('../ios/AlongHealth/Sources/EventTaskNotifications.swift',import.meta.url),'utf8');
  const fn=swift.match(/    private func sameRequest\([\s\S]*?\n    }/);
  assert.ok(fn);
  const program=`import Foundation
import UserNotifications
final class Rule {
${fn[0].replace('private func','func')}
}
func request(hour:Int=1,minute:Int=30,repeats:Bool=true,revision:Int=2,body:String="既有任务")->UNNotificationRequest {
  var calendar=Calendar(identifier:.gregorian);calendar.timeZone=TimeZone(identifier:"Asia/Shanghai")!
  var parts=DateComponents();parts.calendar=calendar;parts.timeZone=calendar.timeZone;parts.hour=hour;parts.minute=minute;parts.second=0
  let content=UNMutableNotificationContent();content.body=body
  content.userInfo=["along":["goalId":"goal","taskId":"task","revision":revision]]
  return UNNotificationRequest(identifier:"stable-task-id",content:content,trigger:UNCalendarNotificationTrigger(dateMatching:parts,repeats:repeats))
}
let rule=Rule(), original=request()
precondition(rule.sameRequest(original,request()))
precondition(!rule.sameRequest(original,request(minute:45)))
precondition(!rule.sameRequest(original,request(repeats:false)))
precondition(!rule.sameRequest(original,request(revision:3)))
precondition(!rule.sameRequest(original,request(body:"已更新的正文")))
`;
  const run=spawnSync('swift',['-'],{input:program,encoding:'utf8'});
  if (run.error?.code!=='ENOENT') assert.equal(run.status,0,run.stderr);
});
