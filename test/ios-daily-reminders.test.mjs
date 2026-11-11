import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const shell = readFileSync(new URL('../ios/AlongHealth/Sources/AlongShellView.swift',import.meta.url),'utf8');
const body = shell.slice(shell.indexOf('        private static func replaceHealthReminders('),shell.indexOf('        func userNotificationCenter(')).replace('private static func replaceHealthReminders','static func replaceHealthReminders').replace(/\bDate\(\)/g,'fixed');
const layoutQueue = '@MainActor enum LayoutQueue {\nstatic func notificationIdentifier(_ s:String)->String{DailyReminderScope.hash(s)}\nstatic func healthReminderPrefix(_ key:String)->String{key=="health" ? "along.health-plan." : "along.custom-health-plan."+DailyReminderScope.hash(key)+"."}\nstatic func notificationStatus(_ setting:StubSettings.Authorization)->String{"denied"}\n'+body+'\n}\n';
const swift = readFileSync(new URL('../ios/AlongHealth/Sources/DailyHealthReminders.swift',import.meta.url),'utf8');

test('each daily topic needs a paid-for iOS queue entry or actual Notification Center item and stays unique after adopting its DSH task',()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-native-daily-'));
  try {
    // Run the production coordinator and identity rules against a recording iOS queue.
    const fakes = `
import Foundation
import CryptoKit

enum AgentBridgeError: Error { case server(String), invalidConfiguration }
final class BackgroundHealthReviews { static let shared=BackgroundHealthReviews();static let goalPreference="bg-goal";func dailyGrantChanged(){} }
final class TestDefaults {
 static let store=TestDefaults();var values=[String:Any]()
 func dictionary(forKey k:String)->[String:Any]?{values[k] as? [String:Any]}
 func stringArray(forKey k:String)->[String]?{values[k] as? [String]}
 func string(forKey k:String)->String?{values[k] as? String}
 func bool(forKey k:String)->Bool{values[k] as? Bool == true}
 func set(_ v:Any,forKey k:String){values[k]=v}
}
struct StubSettings { enum Authorization {case authorized,provisional,ephemeral,denied}; var authorizationStatus:Authorization = .authorized }
class UNNotificationTrigger { var repeats=false }
class UNCalendarNotificationTrigger: UNNotificationTrigger {
  let dateComponents:DateComponents
  init(dateMatching:DateComponents,repeats:Bool){self.dateComponents=dateMatching;super.init();self.repeats=repeats}
  func nextTriggerDate()->Date? { dateComponents.date }
}
final class UNNotificationSound { static let \`default\`=UNNotificationSound() }
final class UNMutableNotificationContent {
 var title="",body="",threadIdentifier=""; var sound:UNNotificationSound?; var userInfo=[AnyHashable:Any]()
}
struct UNNotificationRequest { let identifier:String; let content:UNMutableNotificationContent; let trigger:UNNotificationTrigger? }
struct UNNotification {let request:UNNotificationRequest;let date:Date}
@MainActor final class UNUserNotificationCenter {
 static let instance=UNUserNotificationCenter(); static func current()->UNUserNotificationCenter{instance}
 var pending=[String:UNNotificationRequest](), delivered=[UNNotification](), added=0
 func notificationSettings() async ->StubSettings {.init()}
 func pendingNotificationRequests() async ->[UNNotificationRequest]{Array(pending.values)}
 func deliveredNotifications() async ->[UNNotification]{delivered}
 func add(_ r:UNNotificationRequest) async throws {added+=1;pending[r.identifier]=r}
 func removePendingNotificationRequests(withIdentifiers ids:[String]){for id in ids {pending.removeValue(forKey:id)}}
}
enum AlongConnectionStore {static func load()->[String:String]?{["baseURL":"test-only"]}}
enum AlongWebView { @MainActor enum Coordinator {
 static var run:[String:Any]=[:]
 static func agentRequest(_ i:[String:Any]) async throws->[String:Any]{precondition(i["path"] as? String=="/super-agent/goals/status");return run}
}}
let fixed=Date(timeIntervalSince1970:1794398400) // fixed synthetic UTC date; no user data
`;
    const cases=`
@main struct Check {
 @MainActor static func main() async throws {
  let defaults=UserDefaults.standard; let center=UNUserNotificationCenter.current()
  defaults.set(true,forKey:"along.health.contextReview.v1");defaults.set(["sleep","workout"],forKey:"along.health.selectedTypes")
  let zone=TimeZone(identifier:"Asia/Shanghai")!,day=DailyReminderScope.day(fixed,in:zone),iso=ISO8601DateFormatter()
  let sleepAt=fixed.addingTimeInterval(1800),workAt=fixed.addingTimeInterval(900)
  let v:[String:Any]=["goalKey":"health","localDate":day,"timezone":zone.identifier,"delegated":true,"requestId":"run-test","ticketId":"ticket-test","selectedTypes":["sleep","workout"]]
  let scope=try DailyReminderScope(v,now:fixed), sleepID="sleep-prep-"+day
  let c=UNMutableNotificationContent();c.title="已存在的睡前提醒";c.userInfo=["taskId":sleepID,"goalKey":"health","requestId":"earlier-real-run"]
  var cal=Calendar(identifier:.gregorian);cal.timeZone=zone
  let tr=UNCalendarNotificationTrigger(dateMatching:cal.dateComponents([.calendar,.timeZone,.year,.month,.day,.hour,.minute,.second],from:sleepAt),repeats:false)
  let legacy=UNNotificationRequest(identifier:"along.health-plan."+DailyReminderScope.hash(sleepID),content:c,trigger:tr)
  center.pending[legacy.identifier]=legacy
  let d:[String:Any]=["goalKey":"health","id":"grant-test","topics":["sleep","workout"]]
  let p:[String:Any]=["now":iso.string(from:fixed),"revisionId":"run-test","localDate":day,"timezone":zone.identifier,"dailyDelegation":d]
  let act:[String:Any]=["localDate":day,"reason":"activity","workoutMinutes":20,"workoutReminderAt":iso.string(from:workAt),"sleepReminderAt":iso.string(from:sleepAt),"bedtimeAt":iso.string(from:sleepAt)]
  let layout:[String:Any]=["tasks":[["id":"official-work-task","kind":"reminder","scheduledFor":iso.string(from:workAt)]]]
  let run:[String:Any]=["actual":true,"runtime":"dsh-superagent","status":"done","requestId":"run-test","ticket":["id":"ticket-test"],
     "input":["snapshot":["contextReviewAllowed":true,"selectedTypes":["sleep","workout"],"planning":p]] as [String:Any],
     "result":["layout":layout,"reassessment":["basedOnRevision":"run-test","dailyActions":act] as [String:Any]] as [String:Any]]
  AlongWebView.Coordinator.run=run
  let result=try await DailyHealthReminders.apply(v)
  precondition(result["delegationId"] as? String=="grant-test" && result["appliedRequestId"] as? String=="run-test")
  precondition(DailyHealthReminders.permitsBackground(d,goalKey:"health",selectedTypes:["workout","sleep"]))
  precondition(!DailyHealthReminders.permitsBackground(d,goalKey:"health",selectedTypes:["workout"]))
  let items=result["items"] as! [String:[String:Any]]
  precondition(items["sleep"]?["requestId"] as? String=="earlier-real-run")
  precondition(items["workout"]?["status"] as? String=="scheduled" && center.added==1 && center.pending.count==2)
  _=try await DailyHealthReminders.apply(v);precondition(center.added==1)
  let pending=Array(center.pending.values)
  precondition(DailyHealthReminders.coveredAdoptedID("official-work-task",goalKey:"health",date:workAt,pending:pending)==scope.identifier("workout"))
  precondition(DailyHealthReminders.coveredAdoptedID("official-work-task",goalKey:"custom:wrong",date:workAt,pending:pending)==nil)
  precondition(DailyHealthReminders.coveredAdoptedID("unrelated",goalKey:"health",date:workAt,pending:pending)==nil)
  precondition(DailyHealthReminders.coveredAdoptedID("official-work-task",goalKey:"health",date:sleepAt,pending:pending)==nil)
  let ordinary:[String:Any]=["goalKey":"health","id":"official-work-task","taskId":"official-work-task","requestId":"run-test",
     "title":"Daily workout","body":"test","scheduledFor":iso.string(from:workAt)]
  let adopted=try await LayoutQueue.replaceHealthReminders([ordinary],goalKey:"health",center:center)
  precondition(adopted["scheduledCount"] as? Int==1 && center.added==1 && center.pending.count==2)
  let workout=center.pending[scope.identifier("workout")]!;center.delivered=[UNNotification(request:workout,date:workAt.addingTimeInterval(90))]
  center.pending.removeValue(forKey:workout.identifier)
  let done=try await DailyHealthReminders.apply(v)
  precondition(((done["items"] as? [String:[String:Any]])?["workout"]?["status"] as? String)=="delivered" && center.added==1)
  let visible=(done["items"] as! [String:[String:Any]])["workout"]!
  precondition(visible["scheduledFor"] as? String==iso.string(from:workAt) && visible["deliveredAt"] as? String==iso.string(from:workAt.addingTimeInterval(90)))
  AlongWebView.Coordinator.run=run.merging(["actual":false]){_,n in n}
  do {_=try await DailyHealthReminders.apply(v);fatalError("accepted synthetic run")}catch{}
  AlongWebView.Coordinator.run=run
  _=try await DailyHealthReminders.cancel(["goalKey":"health"])
  precondition(center.pending.count==1 && center.pending[legacy.identifier] != nil)
  do {_=try await DailyHealthReminders.apply(v);fatalError("reused revoked grant")}catch{}
  defaults.values=[:];defaults.set(true,forKey:"along.health.contextReview.v1");defaults.set(["sleep","workout"],forKey:"along.health.selectedTypes")
  center.pending=[legacy.identifier:legacy];center.delivered=[];center.added=0
  let first=try await LayoutQueue.replaceHealthReminders([ordinary],goalKey:"health",center:center)
  precondition(first["scheduledCount"] as? Int==1 && center.pending.count==2)
  _=try await DailyHealthReminders.apply(v)
  precondition(center.added==1 && center.pending.count==2 && center.pending[legacy.identifier] != nil)
  let mapped=await DailyHealthReminders.status(scope)
  precondition(((mapped["items"] as? [String:[String:Any]])?["workout"]?["taskId"] as? String)=="official-work-task")
 }
}
`;

    const source=swift.replace(/^import .+$/gm,'').replaceAll('UserDefaults.standard','TestDefaults.store').replace(/\bDate\(\)/g, 'fixed').replace('recordReadback(readBack, scope: scope, requestID: rid, ticket: ticket)','// iOS file writes are covered by the signed device verification.');
    const script=join(dir,'Test.swift'),exe=join(dir,'run');
    writeFileSync(script,fakes.replaceAll('UserDefaults.standard','TestDefaults.store')+source+layoutQueue+cases.replaceAll('UserDefaults.standard','TestDefaults.store'));
    const build=spawnSync('swiftc',['-parse-as-library','-module-cache-path',join(tmpdir(),'along-daily-tests-swift-cache'),script,'-o',exe],{encoding:'utf8'});
    if(build.error?.code==='ENOENT')return;
    assert.equal(build.status,0,build.stderr);
    const r=spawnSync(exe,[],{encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
