import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const hasSwift=process.platform==='darwin'&&spawnSync('swiftc',['--version']).status===0;
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
function method(source,marker){const a=source.indexOf(marker);assert.ok(a>=0,marker);let b=source.indexOf('{',a),n=1,i=b+1;for(;n;i++){if(source[i]==='{')n++;if(source[i]==='}')n--;}return source.slice(a,i).replace('private func','func');}

test('committed handoff rekeys only exact wrong-scope requests with unchanged clocks, retries safely and preserves other namespaces',{skip:!hasSwift},()=>{
 const source=read('../ios/AlongHealth/Sources/EventTaskNotifications.swift'),dir=mkdtempSync(join(tmpdir(),'along-reminder-repair-'));
 try {
  const methods=['valid','requestID','ownsTaskRequest','ownsResultRequest','sameRequest','rekeyHandoffScope'].map(n=>method(source,`    private func ${n}(`)).join('\n');
  const obsolete=source.match(/let obsolete = (pending\.filter \{[\s\S]*?\n\s*!allowed[^\n]+\})/)?.[1];
  assert.ok(obsolete,'use the real regular reconciliation removal predicate');
  writeFileSync(join(dir,'Check.swift'),`import Foundation
import CryptoKit
import UserNotifications
enum WorkspaceHandoffError:Error {case invalidState}
enum WorkspaceHandoffProof {
 static func isHash(_ s:String?)->Bool {s?.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil}
}
enum DailyReminderScope {static func hash(_ s:String)->String {SHA256.hash(data:Data(s.utf8)).map{String(format:"%02x",$0)}.joined()}}
@MainActor enum AlongConnectionStore {static var pair=["baseURL":"https://cloud.example.com","token":"synthetic-only"];static func load()->[String:String]? {pair}}
@MainActor final class HealthEventDelivery {static let shared=HealthEventDelivery();func notificationScope(_ c:[String:String],user:String)->String? {String(repeating:"e",count:64)}}
@MainActor final class Center {
 var pending=[UNNotificationRequest](),added=0,removed=[String](),failAdd=0,onRead:(()->Void)?
 func pendingNotificationRequests()async->[UNNotificationRequest] {onRead?();return pending}
 func add(_ request:UNNotificationRequest)async throws {added+=1;if added==failAdd{throw WorkspaceHandoffError.invalidState};pending.removeAll{$0.identifier==request.identifier};pending.append(request)}
 func removePendingNotificationRequests(withIdentifiers ids:[String]) {removed+=ids;pending.removeAll{ids.contains($0.identifier)}}
}
@MainActor final class Probe {
 let center=Center(),defaults=UserDefaults(suiteName:CommandLine.arguments[1])!,scopeKey="along.event.notification.scope",prefix="along.event."
 var checkedScope:String?,registered:String?,cursor=0,sentPlan:Data?,planExpires=Date.distantFuture
 ${methods}
 func obsolete(_ pending:[UNNotificationRequest],scope:String,user:String,ids:Set<String>,allowed:Bool)->[UNNotificationRequest] {${'return '+obsolete}}
}
@main struct Fixture {
 @MainActor static func fail(_ operation:()async throws->Void)async {var failed=false;do{try await operation()}catch{failed=true};precondition(failed)}
 @MainActor static func main()async throws {
  let p=Probe(),from=String(repeating:"d",count:64),to=String(repeating:"e",count:64),user="u_12345678",connection=AlongConnectionStore.pair
  defer{p.defaults.removePersistentDomain(forName:CommandLine.arguments[1])}
  p.defaults.set(to,forKey:p.scopeKey)
  func request(_ scope:String,_ task:String,user:String="u_12345678",hour:Int=1)->UNNotificationRequest {
   let id=p.requestID(scope:scope,goal:"g_original",task:task),content=UNMutableNotificationContent()
   content.title="Original title";content.body="Original task text";content.sound = .default
   content.userInfo=["untouched":"metadata","along":["kind":"reminder","userId":user,"goalId":"g_original","taskId":task,"revision":3,"eventId":DailyReminderScope.hash(id+"|3")]]
   var cal=Calendar(identifier:.gregorian);cal.timeZone=TimeZone(identifier:"Asia/Shanghai")!
   var parts=DateComponents();parts.calendar=cal;parts.timeZone=cal.timeZone;parts.hour=hour;parts.minute=30;parts.second=0
   return UNNotificationRequest(identifier:id,content:content,trigger:UNCalendarNotificationTrigger(dateMatching:parts,repeats:true))
  }
  let a=request(from,"t_yoga"),b=request(from,"t_sleep"),other=request(String(repeating:"f",count:64),"t_yoga"),otherUser=request(from,"t_other",user:"u_87654321")
  let arbitrary=UNNotificationRequest(identifier:"along.event.task.unowned",content:UNMutableNotificationContent(),trigger:nil)
  let original=[a,b,other,otherUser,arbitrary];p.center.pending=original
  let result=try await p.rekeyHandoffScope(from:from,to:to,user:user,connection:connection)
  precondition(result["rekeyedCount"] as? Int==2 && result["preservedOtherCount"] as? Int==3)
  precondition(Set(p.center.removed)==Set([a.identifier,b.identifier]) && p.center.pending.count==5)
  for old in [other,otherUser,arbitrary] {precondition(p.center.pending.contains{$0 === old})}
  for task in ["t_yoga","t_sleep"] {
   let new=p.center.pending.first{$0.identifier==p.requestID(scope:to,goal:"g_original",task:task)}!
   precondition(p.sameRequest(new,request(to,task)))
   precondition(new.content.title==a.content.title && new.content.userInfo["untouched"] as? String=="metadata")
  }
  // The regular reconciliation ownership predicate keeps all unrelated namespaces in otherCount.
  precondition(p.center.pending.filter{!p.ownsTaskRequest($0,scope:to,user:user)}.count==3)
  let activeIDs=Set(p.center.pending.filter{p.ownsTaskRequest($0,scope:to,user:user)}.map{$0.identifier})
  precondition(p.obsolete(p.center.pending,scope:to,user:user,ids:activeIDs,allowed:true).isEmpty)
  precondition(p.obsolete(p.center.pending,scope:to,user:user,ids:[],allowed:true).count==2)
  let resultContent=UNMutableNotificationContent();resultContent.userInfo=["along":["kind":"task_result","userId":user,"eventId":"e_result"]]
  let ownedResult=UNNotificationRequest(identifier:"along.event.result."+DailyReminderScope.hash(to+"\\n"+"e_result"),content:resultContent,trigger:nil)
  let otherResult=UNNotificationRequest(identifier:"along.event.result."+DailyReminderScope.hash(from+"\\n"+"e_result"),content:resultContent,trigger:nil)
  precondition(p.obsolete([ownedResult,otherResult],scope:to,user:user,ids:[],allowed:false).map{$0.identifier}==[ownedResult.identifier])
  let repeated=try await p.rekeyHandoffScope(from:from,to:to,user:user,connection:connection)
  precondition(repeated["rekeyedCount"] as? Int==0)
  p.center.pending=original;p.center.added=0;p.center.removed=[];p.center.failAdd=2
  await fail{_ = try await p.rekeyHandoffScope(from:from,to:to,user:user,connection:connection)}
  precondition(p.center.pending.contains{$0.identifier==a.identifier} && p.center.pending.contains{$0.identifier==b.identifier} && p.center.removed.isEmpty)
  p.center.failAdd=0;_ = try await p.rekeyHandoffScope(from:from,to:to,user:user,connection:connection)
  precondition(p.center.pending.count==5 && !p.center.pending.contains{p.ownsTaskRequest($0,scope:from,user:user)})
  // Refuse a collision with a newer target plan before any system mutation.
  p.center.pending=original+[request(to,"t_yoga",hour:2)];p.center.added=0;p.center.removed=[]
  await fail{_ = try await p.rekeyHandoffScope(from:from,to:to,user:user,connection:connection)}
  precondition(p.center.added==0 && p.center.removed.isEmpty)
  p.center.pending=(0..<63).map{UNNotificationRequest(identifier:"other-\\($0)",content:UNMutableNotificationContent(),trigger:nil)}+[a]
  await fail{_ = try await p.rekeyHandoffScope(from:from,to:to,user:user,connection:connection)}
  precondition(p.center.pending.count==64 && p.center.added==0 && p.center.removed.isEmpty)
  p.center.pending=original;p.center.onRead={AlongConnectionStore.pair=["baseURL":"https://changed.example.com"]}
  await fail{_ = try await p.rekeyHandoffScope(from:from,to:to,user:user,connection:connection)}
  precondition(p.center.added==0 && p.center.removed.isEmpty)
  print("PASS exact namespace ownership, calendar/content preservation, partial-add retry, collision/capacity/identity guards")
 }
}
`);
  const binary=join(dir,'check');execFileSync('swiftc',['-parse-as-library',join(dir,'Check.swift'),'-o',binary],{timeout:60000});
  assert.match(execFileSync(binary,['along.reminder.repair.'+Date.now()],{encoding:'utf8',timeout:30000}),/PASS exact namespace ownership/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
