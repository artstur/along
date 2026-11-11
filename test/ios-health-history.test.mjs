import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const models=fileURLToPath(new URL('../ios/AlongHealth/Sources/HealthModels.swift',import.meta.url));
const hasSwift=spawnSync('swiftc',['--version']).status===0;

test('native health history compares complete local weeks using only readable, selected aggregates',{skip:!hasSwift},()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-health-history-'));
  try {
    const main=join(dir,'main.swift');
    writeFileSync(main,`import Foundation
let parser = ISO8601DateFormatter()
func date(_ text: String) -> Date { parser.date(from: text)! }
var calendar = Calendar(identifier: .gregorian)
calendar.timeZone = TimeZone(identifier: "America/New_York")!
// The recent week crosses the spring-forward transition.
let end = date("2026-03-11T04:00:00Z")
let middle = date("2026-03-04T05:00:00Z")
let windows = HealthHistoryWindows(endingAt: end, calendar: calendar)
let workouts = windows.workout([
    (windows.start.addingTimeInterval(-1), 9000), (windows.start, 1200),
    (middle, 1799), (middle.addingTimeInterval(1800), 122),
    (end.addingTimeInterval(-1), 60), (end, 9000)
])
let weights = windows.weight([
    (middle.addingTimeInterval(7200), 64), (middle.addingTimeInterval(60), 60),
    (middle.addingTimeInterval(86400), 65), (end, 90)
])
let sleep = SleepObservationWindow(now: date("2026-03-11T16:00:00Z"), calendar: calendar)
let sleepMiddle = calendar.date(byAdding: .day, value: -7, to: sleep.averageThrough)!
let partial = DateInterval(start: sleep.averageThrough, duration: 6000)
let crossing = DateInterval(start: sleepMiddle.addingTimeInterval(-1800), duration: 5400)
let duplicate = DateInterval(start: sleepMiddle, duration: 3600)
let asleep = sleep.summarize([crossing, duplicate, partial], includeHistory: true)
let noSleep = sleep.summarize([], includeHistory: true)
let previousOnly = sleep.summarize([DateInterval(start: sleepMiddle.addingTimeInterval(-3600), duration: 3600)], includeHistory: true)
var summary = HealthSummary(selected: [.sleep], capturedAt: end)
summary.recentHistory = ["workout": workouts, "sleep": previousOnly.history!, "weight": weights]
let legacyShared = summary.browserSnapshot(contextReviewAllowed: true)
let shared = summary.browserSnapshot(contextReviewAllowed: true, comparisonHistoryAllowed: true)
let unshared = summary.browserSnapshot(contextReviewAllowed: false)
let result: [String: Any] = [
    "workout": workouts, "weight": weights, "sleep": asleep.history!, "latestNight": asleep.latestMinutes!,
    "missingSleep": noSleep.history!, "emptyWorkouts": windows.workout([]),
    "previewRows": summary.historyPreview(for: .sleep).count, "legacySharedKeys": Array((legacyShared["recentHistory"] as! [String: Any]).keys),
    "unshared": unshared["recentHistory"]!, "sharedKeys": Array((shared["recentHistory"] as! [String: Any]).keys),
    "olderSleepReadable": summary.hasReadableValue,
    "legacyHasHistory": sleep.summarize([crossing], includeHistory: false).history != nil
]
print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`);
    const out=join(dir,'check');
    execFileSync('swiftc',['-module-cache-path',join(dir,'cache'),models,main,'-o',out],{stdio:'pipe'});
    const data=JSON.parse(execFileSync(out,{encoding:'utf8'}));
    assert.deepEqual(data.workout.recent,{startAt:'2026-03-04T05:00:00Z',endAt:'2026-03-11T04:00:00Z',count:3,daysWithData:2,value:33});
    assert.deepEqual(data.workout.previous,{startAt:'2026-02-25T05:00:00Z',endAt:data.workout.recent.startAt,count:1,daysWithData:1,value:20});
    assert.equal(data.weight.recent.daysWithData,2);
    assert.equal(data.weight.recent.value,64.5);
    assert.equal(data.weight.previous.value,null);
    assert.deepEqual([data.sleep.previous.value,data.sleep.recent.value,data.latestNight],[30,60,100]);
    assert.equal(data.sleep.recent.daysWithData,1);
    assert.equal(data.sleep.recent.endAt,'2026-03-10T22:00:00Z');
    assert.equal(data.sleep.recent.startAt,'2026-03-03T23:00:00Z');
    assert.equal(data.missingSleep.recent.value,null);
    assert.equal(data.emptyWorkouts.recent.count,null);
    assert.equal(data.emptyWorkouts.recent.value,null);
    assert.equal(data.olderSleepReadable,true);
    assert.equal(data.unshared,null);
    assert.equal(data.previewRows,2);
    assert.deepEqual(data.legacySharedKeys,[]);
    assert.deepEqual(data.sharedKeys,['sleep']);
    assert.equal(data.legacyHasHistory,false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
