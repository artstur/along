import test from 'node:test';
import {validateEnvelope} from '../web/event-envelope.mjs';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const hasSwift = spawnSync('swiftc', ['--version']).status === 0;
let savedFixture;
function fixture() {
  if (savedFixture) return savedFixture;
  const directory = mkdtempSync(join(tmpdir(), 'along-health-context-'));
  try {
    const reader = readFileSync(new URL('../ios/AlongHealth/Sources/HealthKitReader.swift', import.meta.url), 'utf8');
    const outbox = reader.slice(reader.indexOf('enum HealthEventOutbox {'));
    const mapping = reader.slice(reader.indexOf('private static func activityName('), reader.indexOf('private func latestWeight('));
    const activities = [...mapping.matchAll(/case\s+\.\w+:\s+"([^"]+)"/g)].map(match => match[1]);
    activities.push('healthkit_activity_123');
    const main = join(directory, 'Check.swift');
    writeFileSync(main, `import Foundation
${outbox}
@main struct Fixture {
 static func main() throws {
  let iso = ISO8601DateFormatter()
  func date(_ value: String) -> Date { iso.date(from: value)! }
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
  let now = date("2026-11-18T07:45:00Z")
  let window = SleepObservationWindow(now: now, calendar: calendar)
  let sleep = window.summarize([DateInterval(start: date("2026-11-17T19:15:00Z"), end: date("2026-11-18T03:00:00Z"))], includeHistory: false)
  var summary = HealthSummary(selected: [.sleep, .workout, .steps], capturedAt: now, steps: 2000, workoutMinutes: 20, sleepMinutes: sleep.latestMinutes)
  var sleepSummary = sleep.summary!
  sleepSummary["samples"] = [["uuid": "DO_NOT_SEND_RAW"]]
  summary.sleepSummary = sleepSummary
  let activities: [String] = ${JSON.stringify(activities)}
  let patterns: [[String: Any]] = (0..<45).map { i in
   ["activity": activities[i % activities.count], "weekday": i % 7 + 1,
    "hour": i % 24, "count": 1, "recentCount": 1, "averageMinutes": 20,
    "lastObservedAt": "2026-11-18T00:00:00Z", "sampleUUID": "DO_NOT_SEND_RAW"]
  }
  summary.workoutSummary = ["windowDays": 28, "weekStartAt": "2026-11-15T16:00:00Z", "todayMinutes": 20,
    "todayCount": 1, "yesterdayMinutes": 0, "latestWorkoutAt": "2026-11-18T04:00:00Z",
    "patterns": patterns, "rawWorkouts": ["DO_NOT_SEND_RAW"]]
  let rows = summary.eventSummaries(calendar: calendar)
  var repeated = rows
  for i in repeated.indices { repeated[i]["metric_version"] = "2026-11-18T07:46:00.000Z" }
  var changed = summary
  let shifted = window.summarize([DateInterval(start: date("2026-11-17T19:45:00Z"), end: date("2026-11-18T03:30:00Z"))], includeHistory: false)
  changed.sleepSummary = shifted.summary
  let changedRows = changed.eventSummaries(calendar: calendar)
  let legacy = HealthSummary(selected: [.sleep, .workout, .steps], capturedAt: now, steps: 2000, workoutMinutes: 20, sleepMinutes: sleep.latestMinutes)
  var narrowed = summary
  narrowed = HealthSummary(selected: [.steps], capturedAt: now, steps: 2000, sleepSummary: summary.sleepSummary, workoutSummary: summary.workoutSummary)
  let previous = window.summarize([DateInterval(start: date("2026-11-16T19:00:00Z"), end: date("2026-11-17T03:00:00Z"))], includeHistory: false)
  let fallback = HealthSummary(selected: [.sleep], capturedAt: now, sleepSummary: previous.summary)
  let event: [String: Any] = ["event_id": "synthetic-context", "payload": ["summaries": rows]]
  let output: [String: Any] = ["rows": rows, "legacy": legacy.eventSummaries(calendar: calendar),
    "narrowed": narrowed.eventSummaries(calendar: calendar),
    "sameAfterReadRevision": try HealthEventOutbox.content(rows) == HealthEventOutbox.content(repeated),
    "sameAfterSleepShift": try HealthEventOutbox.content(rows) == HealthEventOutbox.content(changedRows),
    "permissionRejectsNarrowing": !HealthEventOutbox.permitted(event, types: [.steps]),
    "changedRows": changedRows, "fallback": fallback.eventSummaries(calendar: calendar)]
  print(String(data: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
 }
}
`);
    const binary = join(directory, 'check');
    execFileSync('swiftc', ['-parse-as-library', '-module-cache-path', join(directory, 'cache'),
      fileURLToPath(new URL('../ios/AlongHealth/Sources/DeviceEventQueue.swift', import.meta.url)),
      fileURLToPath(new URL('../ios/AlongHealth/Sources/HealthModels.swift', import.meta.url)), main, '-o', binary], {timeout: 60000});
    savedFixture = JSON.parse(execFileSync(binary, [], {encoding: 'utf8', timeout: 10000}));
    return savedFixture;
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

test('native sleep event carries observed timing separately from its open aggregation window', {skip: !hasSwift}, () => {
  const sleep = fixture().rows.find(row => row.type === 'sleep');
  assert.equal(sleep.value, 465);
  assert.ok(sleep.context, 'sleep timing context must cross the event boundary');
  assert.equal(sleep.context.latestSleepStartAt, '2026-11-17T19:15:00Z');
  assert.equal(sleep.context.latestWakeAt, '2026-11-18T03:00:00Z');
  assert.equal(sleep.context.latestWindowOpen, true);
  assert.equal(Date.parse(sleep.window.end), Date.parse('2026-11-18T10:00:00Z'));
  assert.notEqual(Date.parse(sleep.context.latestWakeAt), Date.parse(sleep.window.end));
  assert.equal(sleep.context.latestNightMinutes, sleep.value);
});

test('native context sends bounded aggregate fields and preserves legacy missing context', {skip: !hasSwift}, () => {
  const value = fixture();
  const sleep = value.rows.find(row => row.type === 'sleep').context;
  const workout = value.rows.find(row => row.type === 'workout').context;
  assert.ok(sleep, 'sleep aggregate context must be present');
  assert.ok(workout, 'workout aggregate context must be present');
  assert.ok(Object.keys(sleep).every(key => ['windowDays', 'daysWithData', 'averageThroughAt', 'latestWindowOpen',
    'averageMinutes', 'latestNightMinutes', 'previousNightMinutes', 'latestSleepStartAt', 'latestWakeAt'].includes(key)));
  assert.equal(workout.patterns.length, 40);
  assert.equal(workout.patterns[0].activity, 'yoga');
  for (const activity of ['strength_training', 'hiit', 'functional_strength_training', 'healthkit_activity_123']) {
    assert.ok(workout.patterns.some(pattern => pattern.activity === activity));
  }
  assert.ok(workout.patterns.every(pattern => Object.keys(pattern).every(key =>
    ['activity', 'weekday', 'hour', 'count', 'recentCount', 'averageMinutes', 'lastObservedAt'].includes(key))));
  assert.equal(workout.todayMinutes, 20);
  assert.equal(workout.todayCount, 1);
  assert.ok(value.legacy.every(row => row.context === undefined));
  assert.ok(value.rows.every(row => typeof row.value === 'number' || row.value === null));
  assert.ok(!JSON.stringify(value).includes('DO_NOT_SEND_RAW'));
});

test('native outbox notices timing changes with equal duration but ignores read revision and rejected selection', {skip: !hasSwift}, () => {
  const value = fixture();
  assert.equal(value.sameAfterReadRevision, true);
  assert.equal(value.sameAfterSleepShift, false);
  assert.equal(value.changedRows.find(row => row.type === 'sleep').value, value.rows.find(row => row.type === 'sleep').value);
  assert.deepEqual(value.narrowed.map(row => row.type), ['steps']);
  assert.equal(value.narrowed[0].context, undefined);
  assert.equal(value.permissionRejectsNarrowing, true);
});


test('sleep fallback labels the previous night without inventing current-night sleep timing', {skip: !hasSwift}, () => {
  const sleep = fixture().fallback[0];
  assert.equal(sleep.value, 480);
  assert.equal(Date.parse(sleep.window.end), Date.parse('2026-11-17T10:00:00Z'));
  assert.equal(sleep.context.previousNightMinutes, 480);
  assert.equal(sleep.context.latestNightMinutes, undefined);
  assert.equal(sleep.context.latestSleepStartAt, undefined);
  assert.equal(sleep.context.latestWakeAt, undefined);
  assert.equal(sleep.context.latestWindowOpen, true);
});

function wire(rows) {
  return {event_id: 'native-context-vector', schema_version: '1', event_type: 'along.health_summary_updated',
    occurred_at: '2026-11-18T07:45:00Z', timezone: 'Asia/Shanghai',
    payload: {event_type: 'along.health_summary_updated', summaries: rows}};
}

test('actual native context and old scalar-only wire pass the browser mirror contract', {skip: !hasSwift}, () => {
  for (const rows of [fixture().rows, fixture().legacy, fixture().fallback]) {
    assert.equal(validateEnvelope(wire(rows)), null);
  }
});

test('browser mirror strictly rejects malformed or private aggregate context', {skip: !hasSwift}, () => {
  const sleep = fixture().rows.find(row => row.type === 'sleep');
  const workout = fixture().rows.find(row => row.type === 'workout');
  const invalidSleep = [
    {context: null}, {context: []}, {context: {...sleep.context, samples: []}},
    {context: {...sleep.context, user_id: 'foreign'}}, {type: 'steps', unit: 'count'},
    {summarizer_version: 'unknown-producer'}, {context: {...sleep.context, windowDays: 8}},
    {context: {...sleep.context, daysWithData: 8}}, {context: {...sleep.context, daysWithData: 0.5}},
    {context: {...sleep.context, averageThroughAt: 'not-a-time'}}, {context: {...sleep.context, latestWindowOpen: 1}},
    {context: {...sleep.context, latestNightMinutes: 1441}}, {context: {...sleep.context, averageMinutes: -1}},
    {context: {...sleep.context, averageMinutes: Number.POSITIVE_INFINITY}},
    {context: {...sleep.context, latestWakeAt: '2026-11-18T08:00:00Z'}},
    {context: {...sleep.context, latestSleepStartAt: '2026-11-16T19:00:00Z'}},
    {context: {...sleep.context, latestSleepStartAt: '2026-11-18T04:00:00Z'}},
  ];
  const pattern = workout.context.patterns[0];
  const invalidWorkout = [
    {context: {...workout.context, rawWorkouts: []}}, {context: {...workout.context, patterns: Array(41).fill(pattern)}},
    {context: {...workout.context, todayCount: 0.5}}, {context: {...workout.context, todayMinutes: 40321}},
    {context: {...workout.context, weekStartAt: '2026-11-18T08:00:00Z'}},
    ...[
      {sampleUUID: 'private'}, {activity: 'private free text'}, {weekday: 0}, {hour: 24}, {recentCount: 2},
      {count: 10001}, {averageMinutes: -1}, {lastObservedAt: '2026-11-18T08:00:00Z'},
    ].map(fields => ({context: {...workout.context, patterns: [{...pattern, ...fields}]}})),
  ];
  for (const [row, changes] of [[sleep, invalidSleep], [workout, invalidWorkout]]) {
    for (const change of changes) assert.equal(typeof validateEnvelope(wire([{...row, ...change}])), 'string');
    for (const key of Object.keys(row.context)) {
      if (row.type === 'sleep' && !['windowDays', 'daysWithData', 'averageThroughAt', 'latestWindowOpen'].includes(key)) continue;
      const context = {...row.context}; delete context[key];
      assert.equal(typeof validateEnvelope(wire([{...row, context}])), 'string', `missing ${key}`);
    }
  }
});
