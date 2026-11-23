import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateEnvelope} from '../web/event-envelope.mjs';

const hasSwift=spawnSync('swiftc',['--version']).status===0;
let cached;
function fixture() {
 if(cached)return cached;
 const dir=mkdtempSync(join(tmpdir(),'along-health-details-'));
 try {
  const main=join(dir,'Check.swift');
  const reader=readFileSync(new URL('../ios/AlongHealth/Sources/HealthKitReader.swift',import.meta.url),'utf8');
  const outbox=reader.slice(reader.indexOf('enum HealthEventOutbox {'));
  writeFileSync(main,`import Foundation
${outbox}
@main struct Fixture {
 static func main() throws {
  let iso=ISO8601DateFormatter()
  func date(_ s:String)->Date {iso.date(from:s)!}
  var calendar=Calendar(identifier:.gregorian);calendar.timeZone=TimeZone(identifier:"Asia/Shanghai")!
  let now=date("2026-11-24T04:00:00Z")
  let start=date("2026-11-24T01:00:00Z"),end=date("2026-11-24T02:00:00Z")
  let good=WorkoutObservation(activity:"strength_training",start:start,end:end,durationSeconds:2700,location:"indoor",distanceMeters:nil,activeEnergyKcal:250,averageHeartRateBpm:120,maximumHeartRateBpm:160,effortScore:6,estimatedEffortScore:nil)
  let missing=WorkoutObservation(activity:"walking",start:start,end:end,durationSeconds:3600,location:"unknown")
  let invalid=WorkoutObservation(activity:"running",start:end,end:start,durationSeconds:3600,location:"outdoor")
  let impossible=WorkoutObservation(activity:"running",start:start,end:end,durationSeconds:7200,location:"outdoor")
  let future=WorkoutObservation(activity:"cycling",start:start,end:now.addingTimeInterval(60),durationSeconds:60,location:"outdoor")
  let a=date("2026-11-23T18:00:00Z"),b=date("2026-11-23T19:00:00Z"),c=date("2026-11-23T20:00:00Z"),d=date("2026-11-23T21:00:00Z")
  let stages=[SleepStageObservation(interval:DateInterval(start:a,end:b),stage:"core"),
    SleepStageObservation(interval:DateInterval(start:a,end:b),stage:"core"),
    SleepStageObservation(interval:DateInterval(start:b,end:c),stage:"deep"),
    SleepStageObservation(interval:DateInterval(start:b,end:c),stage:"rem"),
    SleepStageObservation(interval:DateInterval(start:a,end:c),stage:"unspecified"),
    SleepStageObservation(interval:DateInterval(start:c,end:d),stage:"awake")]
  let window=SleepObservationWindow(now:now,calendar:calendar)
  let sleep=window.summarize([DateInterval(start:a,end:c),DateInterval(start:d,end:d.addingTimeInterval(1800))],includeHistory:false,stages:stages)
  var summary=HealthSummary(selected:[.sleep,.workout],capturedAt:now,workoutMinutes:45,sleepMinutes:sleep.latestMinutes)
  summary.sleepSummary=sleep.summary
  var sessions=(0..<9).map { _ in good.payload(observedAt:now)! }
  sessions[0]["sampleUUID"]="PRIVATE_UUID";sessions[0]["latitude"]=23.1
  summary.workoutSummary=["windowDays":28,"weekStartAt":"2026-11-22T16:00:00Z","todayMinutes":45,"todayCount":1,"yesterdayMinutes":0,"latestWorkoutAt":iso.string(from:start),"patterns":[],"recentSessions":sessions]
  let rows=summary.eventSummaries(calendar:calendar)
  var reread=rows
  for i in reread.indices {reread[i]["metric_version"]="2026-11-24T04:01:00Z"}
  var correction=summary
  var revisedSessions=sessions;revisedSessions[0]["effortScore"]=7
  correction.workoutSummary?["recentSessions"]=revisedSessions
  let output:[String:Any]=["good":good.payload(observedAt:now)!,"missing":missing.payload(observedAt:now)!,
   "invalid":invalid.payload(observedAt:now) as Any? ?? NSNull(),"impossible":impossible.payload(observedAt:now) as Any? ?? NSNull(),"future":future.payload(observedAt:now) as Any? ?? NSNull(),
   "rows":rows,"denied":summary.browserSnapshot(contextReviewAllowed:false),
   "sameAfterReread":try HealthEventOutbox.content(rows)==HealthEventOutbox.content(reread),
   "sameAfterCorrection":try HealthEventOutbox.content(rows)==HealthEventOutbox.content(correction.eventSummaries(calendar:calendar))]
  print(String(data:try JSONSerialization.data(withJSONObject:output,options:[.sortedKeys]),encoding:.utf8)!)
 }
}`);
  const models=fileURLToPath(new URL('../ios/AlongHealth/Sources/HealthModels.swift',import.meta.url));
  const binary=join(dir,'check');
  const queue=fileURLToPath(new URL('../ios/AlongHealth/Sources/DeviceEventQueue.swift',import.meta.url));
  execFileSync('swiftc',['-parse-as-library','-module-cache-path',join(dir,'cache'),queue,models,main,'-o',binary],{timeout:60000});
  cached=JSON.parse(execFileSync(binary,[],{encoding:'utf8',timeout:10000}));return cached;
 } finally {rmSync(dir,{recursive:true,force:true});}
}
function wire(rows) {return {event_id:'health-detail-fixture',schema_version:'1',event_type:'along.health_summary_updated',occurred_at:'2026-11-24T04:00:00Z',timezone:'Asia/Shanghai',payload:{event_type:'along.health_summary_updated',summaries:rows}};}

test('shared health detail vectors preserve strict browser and Agent mirror boundaries',()=>{
 const vectors=JSON.parse(readFileSync(new URL('./fixtures/health-context-v2.json',import.meta.url),'utf8'));
 assert.equal(validateEnvelope(wire([vectors.workout,vectors.sleep])),null);
 for(const patch of vectors.invalidWorkoutPatches) {
  const context={...vectors.workout.context,recentSessions:[{...vectors.workout.context.recentSessions[0],...patch}]};
  assert.equal(typeof validateEnvelope(wire([{...vectors.workout,context}])),'string');
 }
 for(const patch of vectors.invalidSleepPatches)assert.equal(typeof validateEnvelope(wire([{...vectors.sleep,context:{...vectors.sleep.context,...patch}}])),'string');
});

test('native workout details retain active duration and only actually observed measurements',{skip:!hasSwift},()=>{
 const f=fixture();assert.equal(f.good.durationMinutes,45);assert.equal(f.good.location,'indoor');assert.equal(f.good.effortScore,6);
 assert.equal(f.good.distanceMeters,undefined);assert.equal(f.missing.averageHeartRateBpm,undefined);assert.equal(f.missing.effortScore,undefined);
 for(const key of ['invalid','impossible','future'])assert.equal(f[key],null,key);
 const workout=f.rows.find(r=>r.type==='workout');assert.equal(workout.context.recentSessions.length,7);
 assert.ok(!JSON.stringify(f.rows).includes('PRIVATE_UUID'));assert.ok(!JSON.stringify(f.rows).includes('latitude'));
 assert.equal(f.denied.workoutSummary,null);assert.equal(f.denied.sleepSummary,null);
 assert.equal(f.sameAfterReread,true);assert.equal(f.sameAfterCorrection,false);
});

test('native sleep stage aggregation deduplicates and marks contradictory stages without double counting',{skip:!hasSwift},()=>{
 const sleep=fixture().rows.find(r=>r.type==='sleep');
 assert.equal(sleep.context.latestAsleepSegmentCount,2);assert.equal(sleep.context.latestLongestAsleepMinutes,120);
 assert.equal(sleep.context.latestStageMinutes.core,60);assert.equal(sleep.context.latestStageMinutes.unspecified,60);
 assert.equal(sleep.context.latestStageMinutes.awake,60);assert.equal(sleep.context.latestStageMinutes.deep,undefined);
 assert.equal(sleep.context.latestStageOverlap,true);assert.equal(validateEnvelope(wire(fixture().rows)),null);
});

test('strict wire refuses private nested fields, impossible workout timing and invalid sleep detail',{skip:!hasSwift},()=>{
 const f=fixture(),workout=f.rows.find(r=>r.type==='workout'),sleep=f.rows.find(r=>r.type==='sleep');
 const item=workout.context.recentSessions[0];
 for(const patch of [{latitude:1},{sampleUUID:'private'},{location:'gym-name'},{durationMinutes:61},{effortScore:11},{averageHeartRateBpm:401},{averageHeartRateBpm:180,maximumHeartRateBpm:160},{startAt:'2026-11-25T00:00:00Z'},{startAt:'2026-09-01T00:00:00Z'}]) {
  assert.equal(typeof validateEnvelope(wire([{...workout,context:{...workout.context,recentSessions:[{...item,...patch}]}}])),'string',JSON.stringify(patch));
 }
 for(const patch of [{recentSessions:Array(8).fill(item)},{recentSessions:null}])assert.equal(typeof validateEnvelope(wire([{...workout,context:{...workout.context,...patch}}])),'string');
 const newer={...item,startAt:'2026-11-24T02:00:00Z',endAt:'2026-11-24T03:00:00Z'};
 assert.equal(typeof validateEnvelope(wire([{...workout,context:{...workout.context,recentSessions:[item,newer]}}])),'string');
 for(const patch of [{latestAsleepSegmentCount:0},{latestLongestAsleepMinutes:200},{latestStageMinutes:{core:152}},{latestStageMinutes:{samples:[]}},{latestStageOverlap:1},{latestStageMinutes:{}}]) {
  assert.equal(typeof validateEnvelope(wire([{...sleep,context:{...sleep.context,...patch}}])),'string',JSON.stringify(patch));
 }
});

test('workout detail permissions are read-only and requested only from explicit selected workout read',()=>{
 const source=readFileSync(new URL('../ios/AlongHealth/Sources/HealthKitReader.swift',import.meta.url),'utf8');
 assert.match(source,/if requestPermission[\s\S]*workoutDetailReadTypes/);
 assert.match(source,/requestAuthorization\(toShare: Set<HKSampleType>\(\), read: types\)/);
 assert.match(source,/predicateForWorkoutEffortSamplesRelated\(workout: workout, activity: nil\)/);
 assert.match(source,/HKQuery\.predicateForObjects\(from: workout\)/);
 assert.ok(!source.includes('_HKPrivate'));assert.ok(!source.includes('HKWorkoutRouteQuery'));
});
