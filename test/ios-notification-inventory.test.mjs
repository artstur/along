import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const hasSwift=process.platform==='darwin'&&spawnSync('swiftc',['--version']).status===0;
test('Native system notification inventory is offline, read-only and contains route/timing metadata without notification body',{skip:!hasSwift},()=>{
 const source=readFileSync(new URL('../ios/AlongHealth/Sources/EventTaskNotifications.swift',import.meta.url),'utf8');
 const start=source.indexOf('    func readOnlyInventory('),brace=source.indexOf('{',start);let n=1,end=brace+1;
 for(;n;end++){if(source[end]==='{')n++;if(source[end]==='}')n--;}
 const method=source.slice(start,end),dir=mkdtempSync(join(tmpdir(),'along-notify-inventory-'));
 try {
  writeFileSync(join(dir,'Check.swift'),`import Foundation
enum Status:Int {case authorized=2}
struct Settings {var authorizationStatus=Status.authorized,alertSetting=Status.authorized}
class UNNotificationTrigger {}
final class UNCalendarNotificationTrigger:UNNotificationTrigger {var repeats=true;var dateComponents:DateComponents {var c=DateComponents();c.hour=1;c.minute=30;c.timeZone=TimeZone(identifier:"Asia/Shanghai");return c};func nextTriggerDate()->Date?{Date(timeIntervalSince1970:2000000000)}}
final class UNTimeIntervalNotificationTrigger:UNNotificationTrigger {var repeats=false,timeInterval=60.0;func nextTriggerDate()->Date?{nil}}
struct Content {var userInfo:[AnyHashable:Any];var body="MUST_NOT_EXPORT_BODY",title="MUST_NOT_EXPORT_TITLE"}
struct UNNotificationRequest {var identifier:String,content:Content,trigger:UNNotificationTrigger?}
struct Notice {var request:UNNotificationRequest,date:Date}
// No add/remove/reconcile/permission/Host APIs exist on this fixture. A mutation fails to compile.
@MainActor final class ReadOnlyCenter {
 var calls=[String]()
 let req=UNNotificationRequest(identifier:"along.event.task.original",content:Content(userInfo:["along":["userId":"u_12345678","goalId":"g_original","taskId":"t_yoga","revision":1],"secret":"FORBIDDEN"]),trigger:UNCalendarNotificationTrigger())
 func notificationSettings()async->Settings {calls.append("settings");return Settings()}
 func pendingNotificationRequests()async->[UNNotificationRequest] {calls.append("pending");return [req,UNNotificationRequest(identifier:"other.app.request",content:Content(userInfo:[:]),trigger:nil)]}
 func deliveredNotifications()async->[Notice] {calls.append("delivered");return [Notice(request:req,date:Date(timeIntervalSince1970:1900000000))]}
}
@MainActor final class Probe {let center=ReadOnlyCenter();${method}}
@main struct Fixture {@MainActor static func main()async throws {
 let p=Probe(),v=await p.readOnlyInventory(),text=String(data:try JSONSerialization.data(withJSONObject:v),encoding:.utf8)!
 precondition(p.center.calls==["settings","pending","delivered"])
 precondition((v["pending"] as! [[String:Any]]).count==1 && (v["delivered"] as! [[String:Any]]).count==1 && v["otherPendingCount"] as? Int==1)
 let row=(v["pending"] as! [[String:Any]])[0]
 precondition(row["requestId"] as? String=="along.event.task.original" && (row["calendar"] as! [String:Any])["timezone"] as? String=="Asia/Shanghai" && text.contains("notificationCenterDate"))
 precondition(!text.contains("MUST_NOT_EXPORT") && !text.contains("FORBIDDEN") && !text.contains("other.app.request"))
 print("PASS pure read inventory keeps request IDs and timing without user content or mutations")
}}
`);
  const bin=join(dir,'check');execFileSync('swiftc',['-parse-as-library',join(dir,'Check.swift'),'-o',bin],{timeout:60000});
  assert.match(execFileSync(bin,[],{encoding:'utf8'}),/PASS pure read inventory/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
