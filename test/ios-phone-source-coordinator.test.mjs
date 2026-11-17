import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const hasSwift = process.platform === 'darwin' && spawnSync('swiftc', ['--version']).status === 0;
test('phone source coordinator recovers durable intents, scopes secrets and fails closed across revocation races', {skip: !hasSwift}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'along-phone-source-'));
  try {
    const harness = join(directory, 'Check.swift');
    writeFileSync(harness, String.raw`
import Foundation
import CryptoKit

enum AgentBridgeError: Error { case receipt([String:Any]); case server(String) }
@MainActor enum AlongConnectionStore { static func load() -> [String:String]? { nil } }
@MainActor enum AlongWebView { enum Coordinator { static func agentRequest(_ input:[String:Any],privateSourceRequest:Bool)async throws->[String:Any]{fatalError("real transport forbidden")}} }
enum HealthMetric: Hashable { case steps }
struct HealthSummary {}
@MainActor final class HealthKitReader {
    func read(_ types:Set<HealthMetric>,requestPermission:Bool,includeContext:Bool)async throws->HealthSummary{fatalError("health collection forbidden")}
}
private enum Injected: Error { case failure }
private final class Clock: @unchecked Sendable {
    private let lock=NSLock();private var date=Date(timeIntervalSince1970:1_795_000_000)
    func now()->Date{lock.lock();defer{lock.unlock()};return date}
    func advance(_ seconds:Double){lock.lock();date=date.addingTimeInterval(seconds);lock.unlock()}
}
@MainActor private final class Pair {
    var value=["baseURL":"https://192.168.1.4:4176","fingerprint":String(repeating:"a",count:64),"token":String(repeating:"b",count:64)]
    var unlocked=true
}
@MainActor private final class Keys: PhoneSourceCredentialStore {
    var values=[String:OKXDeviceCredentials](),deletionFails=false
    var onSave:(()->Void)?,onDelete:(()->Void)?
    func load(account:String)throws->OKXDeviceCredentials?{values[account]}
    func save(_ value:OKXDeviceCredentials,account:String)throws{values[account]=value;onSave?()}
    func delete(account:String)throws{onDelete?();if deletionFails{throw Injected.failure};values.removeValue(forKey:account)}
    func clone()->Keys{let k=Keys();k.values=values;return k}
}
@MainActor private final class Records: PhoneSourceStateStore {
    var files=[String:Data]();var beforeSave:(([String:Any])throws->Void)?
    func load(scope:String)throws->[String:Any]?{guard let data=files[scope]else{return nil};return try JSONSerialization.jsonObject(with:data)as?[String:Any]}
    func save(_ state:[String:Any],scope:String)throws{try beforeSave?(state);files[scope]=try JSONSerialization.data(withJSONObject:state,options:[.sortedKeys])}
    func scopes()throws->[String]{Array(files.keys)}
    func record()->[String:Any]{try! JSONSerialization.jsonObject(with:files.values.first!)as![String:Any]}
    func clone()->Records{let r=Records();r.files=files;return r}
}
private actor API {
    let clock:Clock;var permission="read_only",failure=false,calls=0,holding=false,waiting=false
    var continuation:CheckedContinuation<Void,Never>?
    init(_ clock:Clock){self.clock=clock}
    func setPermission(_ p:String){permission=p}
    func setFailure(_ f:Bool){failure=f}
    func hold(){holding=true}
    func isWaiting()->Bool{waiting}
    func release(){holding=false;waiting=false;continuation?.resume();continuation=nil}
    func count()->Int{calls}
    func response(_ request:URLRequest,_ limit:Int)async throws->(Data,HTTPURLResponse){
        calls+=1
        if holding{waiting=true;await withCheckedContinuation{continuation=$0}}
        if failure{throw NSError(domain:"fixture",code:1,userInfo:[NSLocalizedDescriptionKey:"synthetic-secret"])}
        let path=request.url!.path,rows:[[String:Any]]
        switch path{
        case "/api/v5/public/time":rows=[["ts":String(Int64(clock.now().timeIntervalSince1970*1000))]]
        case "/api/v5/account/config":rows=[["perm":permission]]
        case "/api/v5/account/balance":rows=[["totalEq":"1234.56","details":[["ccy":"BTC"],["ccy":"USDT"]]]]
        case "/api/v5/account/positions":rows=[["pos":"1"]]
        default:fatalError("unexpected external endpoint")
        }
        return(try JSONSerialization.data(withJSONObject:["code":"0","data":rows]),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
    }
}
@MainActor private final class Host {
    struct Remote {var grant:String;var request:String;var phase="pending";var seq=0;var opens=[String:String]();var events=[String:Data]()}
    var records=[String:Remote](),requests=[[String:Any]](),rotations=0
    var offline=false,loseOpenOnce=false,wrongReceiptOnce=false,terminal:String?
    var suspendNextPublish=false,publishWaiting=false,publishContinuation:CheckedContinuation<Void,Never>?
    var onOpen:(([String:Any])->Void)?,onPublish:(([String:Any])->Void)?
    func clone()->Host{let h=Host();h.records=records;h.rotations=rotations;return h}
    func releasePublish(){publishWaiting=false;publishContinuation?.resume();publishContinuation=nil}
    func call(_ input:[String:Any])async throws->[String:Any]{
        precondition(input["path"]as?String=="/sources/device")
        let body=input["body"]as![String:Any],action=body["action"]as!String,goal=body["goalId"]as!String
        let text=String(data:try JSONSerialization.data(withJSONObject:body),encoding:.utf8)!
        for forbidden in ["apiKey","secretKey","passphrase","synthetic-api","synthetic-secret","synthetic-pass"]{precondition(!text.contains(forbidden),"source transport cannot contain secrets")}
        requests.append(body)
        if offline{throw AgentBridgeError.server("synthetic-secret")}
        if action=="context"{return["provider":"okx","goalId":goal,"userId":"u_fixture","deviceId":"d_fixture"]}
        if action=="open"{
            onOpen?(body)
            let request=body["requestId"]as!String
            if let r=records[goal],let old=r.opens[request]{return["provider":"okx","goalId":goal,"userId":"u_fixture","deviceId":"d_fixture","grantId":old,"state":old==r.grant ? r.phase:"disconnected"]}
            rotations+=1;let grant=String(format:"%064x",rotations)
            var r=Remote(grant:grant,request:request);r.opens=records[goal]?.opens ?? [:];r.opens[request]=grant;records[goal]=r
            if loseOpenOnce{loseOpenOnce=false;throw AgentBridgeError.server("lost open response")}
            return["provider":"okx","goalId":goal,"userId":"u_fixture","deviceId":"d_fixture","grantId":grant,"state":"pending"]
        }
        if action=="status"{
            guard let r=records[goal]else{return["provider":"okx","state":"disconnected"]}
            if let request=body["requestId"]as?String{
                guard let grant=r.opens[request]else{return["provider":"okx","state":"disconnected"]}
                return["provider":"okx","state":grant==r.grant ? r.phase:"disconnected","grantId":grant]
            }
            return["provider":"okx","state":r.phase,"grantId":r.grant]
        }
        let id=body["eventId"]as!String
        if action=="publish"{
            onPublish?(body)
            if suspendNextPublish{suspendNextPublish=false;publishWaiting=true;await withCheckedContinuation{publishContinuation=$0}}
        }
        if let terminal{return["event_id":id,"status":terminal]}
        guard var r=records[goal],r.grant==body["grantId"]as?String else{return["event_id":id,"status":"stale"]}
        let encoded=try JSONSerialization.data(withJSONObject:body,options:[.sortedKeys])
        let status:String
        if let prior=r.events[id]{status=prior==encoded ? "duplicate":"conflict"}
        else if (body["sequence"]as!Int)<=r.seq || r.phase=="disconnected"{status="stale"}
        else{r.events[id]=encoded;r.seq=body["sequence"]as!Int;r.phase=action=="publish" ? "connected":"disconnected";records[goal]=r;status="accepted"}
        if wrongReceiptOnce{wrongReceiptOnce=false;return["event_id":"wrong-event","status":"accepted"]}
        return["event_id":id,"status":status]
    }
}
@MainActor private final class World {
    let clock=Clock(),pair=Pair(),api:API,keys:Keys,storage:Records,host:Host
    init(keys:Keys?=nil,storage:Records?=nil,host:Host?=nil){self.keys=keys ?? Keys();self.storage=storage ?? Records();self.host=host ?? Host();api=API(clock)}
    func coordinator()->PhoneSourceCoordinator{
        let client=OKXDeviceClient(transport:{[api]request,limit in try await api.response(request,limit)},now:{[clock]in clock.now()})
        return PhoneSourceCoordinator(client:client,transport:{[host]in try await host.call($0)},keychain:keys,storage:storage,connection:{[pair]in pair.value},protectedDataAvailable:{[pair]in pair.unlocked},now:{[clock]in clock.now()})
    }
}
@MainActor private let credentials=OKXDeviceCredentials(apiKey:"synthetic-api",secretKey:"synthetic-secret",passphrase:"synthetic-pass")
@MainActor private func connected(_ coordinator:PhoneSourceCoordinator,_ goal:String="g_fixture")async throws->[String:Any]{try await coordinator.connect(goalID:goal,site:.global,credentials:credentials)}
@MainActor private func settle()async{for _ in 0..<80{try? await Task.sleep(nanoseconds:2_000_000)}}
@MainActor private func waitForAPI(_ api:API)async{for _ in 0..<100{if await api.isWaiting(){return};try? await Task.sleep(nanoseconds:2_000_000)};fatalError("test API did not suspend")}
@MainActor private func check(_ snapshot:[String:Any],_ state:String,_ sync:String?=nil){
    precondition(snapshot["provider"]as?String=="okx"&&snapshot["state"]as?String==state)
    if let sync{precondition(snapshot["syncState"]as?String==sync)}
    let keys=Set(snapshot.keys);precondition(keys.isSubset(of:["provider","state","summary","lastSyncedAt","syncState"]))
    if state=="connected"{precondition((snapshot["summary"]as?[String:Any])?["tradingEquityUsd"]as?Double==1234.56)}
    else{precondition(snapshot["summary"]==nil)}
}

@main private struct Check {
    @MainActor static func main()async throws{
        // Crash boundary 1: open rotates remotely but its response is lost.
        let a=World(),ca=a.coordinator();a.host.loseOpenOnce=true
        check(try await ca.status(goalID:"g_fixture"),"disconnected","none")
        do{_=try await connected(ca);fatalError("open response should fail")}catch{precondition(error as?PhoneSourceCoordinatorError == .hostUnavailable)}
        let request=a.storage.record()["requestId"]as!String
        check(try await ca.status(goalID:"g_fixture"),"disconnected","none")
        check(try await connected(a.coordinator()),"connected","received")
        precondition(a.host.rotations==1 && a.host.requests.filter{$0["action"]as?String=="open"}.allSatisfy{$0["requestId"]as?String==request})
        // API failures retry the same durable intent and grant, never rotate implicitly.
        let b=World();await b.api.setFailure(true)
        do{_=try await connected(b.coordinator());fatalError("API should fail")}catch{precondition(error is OKXDeviceClientError)}
        let oldRequest=b.storage.record()["requestId"]as!String
        check(try await b.coordinator().status(goalID:"g_fixture"),"disconnected","none")
        await b.api.setFailure(false);check(try await connected(b.coordinator()),"connected","received")
        precondition(b.host.rotations==1 && b.storage.record()["requestId"]as?String==oldRequest)

        // Crash boundary 2: Keychain committed, summary/outbox file not committed.
        let c=World();var keyCrash:(Keys,Records,Host)?
        c.keys.onSave={if keyCrash==nil{keyCrash=(c.keys.clone(),c.storage.clone(),c.host.clone())}}
        _=try await connected(c.coordinator())
        let (ck,cs,ch)=keyCrash!;precondition(cs.record()["phase"]as?String=="collecting" && cs.record()["summary"]==nil)
        let c2=World(keys:ck,storage:cs,host:ch)
        check(try await c2.coordinator().status(goalID:"g_fixture"),"connected","received")
        precondition(c2.host.rotations==1)

        // Crash boundary 3: queue is durable before any publish reaches Host.
        let d=World();var queuedCrash:(Keys,Records,Host)?
        d.host.onPublish={body in
            let record=d.storage.record(),pending=record["pending"]as![[String:Any]]
            precondition(pending.first?["event_id"]as?String==body["eventId"]as?String)
            if queuedCrash==nil{queuedCrash=(d.keys.clone(),d.storage.clone(),d.host.clone())}
        }
        _=try await connected(d.coordinator())
        let (dk,ds,dh)=queuedCrash!,d2=World(keys:dk,storage:ds,host:dh)
        check(try await d2.coordinator().status(goalID:"g_fixture"),"connected","received")
        let dCalls=await d2.api.count();precondition(dCalls==0,"committed snapshot retries without collecting again")

        // Crash boundary 4: Host accepted, local acknowledgement write fails.
        let e=World();var failAck=true
        e.storage.beforeSave={state in if failAck,state["receivedSequence"]as?Int==1{failAck=false;throw Injected.failure}}
        do{_=try await connected(e.coordinator());fatalError("ack write should fail")}catch{precondition(error as?PhoneSourceCoordinatorError == .storageUnavailable)}
        let event=((e.storage.record()["pending"]as![[String:Any]]).first!["event_id"]as!String)
        check(try await e.coordinator().status(goalID:"g_fixture"),"connected","received")
        precondition(e.host.requests.filter{$0["action"]as?String=="publish"}.allSatisfy{$0["eventId"]as?String==event})

        let f=World();f.host.wrongReceiptOnce=true
        check(try await connected(f.coordinator()),"connected","pending")
        check(try await f.coordinator().status(goalID:"g_fixture"),"connected","received")
        f.host.offline=true
        check(try await f.coordinator().refresh(goalID:"g_fixture"),"connected","pending")
        check(try await f.coordinator().status(goalID:"g_fixture"),"connected","pending")
        f.host.offline=false;check(try await f.coordinator().status(goalID:"g_fixture"),"connected","received")

        // Deletion failure leaves a durable tombstone and must never collect.
        let g=World(),cg=g.coordinator();_=try await connected(cg)
        g.keys.deletionFails=true
        g.keys.onDelete={precondition(g.storage.record()["phase"]as?String=="revoking")}
        let before=await g.api.count()
        do{_=try await cg.disconnect(goalID:"g_fixture");fatalError("deletion must fail")}catch{precondition(error as?PhoneSourceCoordinatorError == .credentialDeletionFailed)}
        precondition(g.storage.record()["phase"]as?String=="revoking" && g.keys.values.count==1)
        g.keys.deletionFails=false
        check(try await g.coordinator().status(goalID:"g_fixture"),"disconnected","received")
        let after=await g.api.count();precondition(before==after && g.keys.values.isEmpty)

        let h=World(),hc=h.coordinator();_=try await connected(hc);await h.api.setPermission("read_only,trade")
        do{_=try await hc.refresh(goalID:"g_fixture");fatalError("changed permissions must revoke")}catch{precondition(error as?OKXDeviceClientError == .permissionDenied)}
        check(try await hc.status(goalID:"g_fixture"),"disconnected","received");precondition(h.keys.values.isEmpty)
        for terminal in ["stale","rejected","conflict"]{
            let w=World(),co=w.coordinator();w.host.terminal=terminal
            do{_=try await connected(co);fatalError("terminal receipt should stop grant")}catch{precondition(error as?PhoneSourceCoordinatorError == .authorizationChanged)}
            let calls=await w.api.count();check(try await co.status(goalID:"g_fixture"),"disconnected","none")
            let later=await w.api.count();precondition(calls==later && w.keys.values.isEmpty && !(w.storage.record()["held"]as![[String:Any]]).isEmpty)
        }

        // Pair change and user disconnect invalidate an in-flight collection.
        let i=World(),ic=i.coordinator();await i.api.hold()
        let old=Task{try await connected(ic)};await waitForAPI(i.api)
        i.pair.value["token"]=String(repeating:"c",count:64);await i.api.release()
        do{_=try await old.value;fatalError("changed pair must fail")}catch{precondition(error as?PhoneSourceCoordinatorError == .authorizationChanged)}
        precondition(i.keys.values.isEmpty);check(try await ic.status(goalID:"g_fixture"),"disconnected")
        let j=World(),jc=j.coordinator();await j.api.hold()
        let opening=Task{try await connected(jc)};await waitForAPI(j.api)
        check(try await jc.disconnect(goalID:"g_fixture"),"disconnected","received")
        await j.api.release()
        do{_=try await opening.value;fatalError("revoked read must fail")}catch{precondition(error as?PhoneSourceCoordinatorError == .authorizationChanged)}
        precondition(j.keys.values.isEmpty && !j.host.requests.contains{$0["action"]as?String=="publish"})

        // Missing grant after lost open is resolved by read-only status(requestId).
        let k=World(),kc=k.coordinator();k.host.loseOpenOnce=true
        do{_=try await connected(kc)}catch{}
        let rotations=k.host.rotations
        check(try await kc.disconnect(goalID:"g_fixture"),"disconnected","received")
        precondition(k.host.rotations==rotations && k.host.requests.contains{$0["action"]as?String=="status"&&$0["requestId"] != nil})

        let l=World(),lc=l.coordinator();_=try await connected(lc)
        l.pair.value["baseURL"]="https://192.168.1.9:4176"
        check(try await lc.status(goalID:"g_fixture"),"connected","received")
        l.pair.unlocked=false
        do{_=try await lc.status(goalID:"g_fixture");fatalError("locked data must defer")}catch{precondition(error as?PhoneSourceCoordinatorError == .protectedDataUnavailable)}
        l.pair.unlocked=true
        let count=await l.api.count();lc.resumeForeground();await settle();let recent=await l.api.count();precondition(count==recent)
        l.clock.advance(301);await l.api.setFailure(true);lc.resumeForeground();await settle();let failed=await l.api.count();precondition(failed>recent)
        lc.resumeForeground();await settle();let backedOff=await l.api.count();precondition(backedOff==failed)
        l.clock.advance(61);lc.resumeForeground();await settle();let retried=await l.api.count();precondition(retried>backedOff)

        // Successful API read followed by a queue-save failure compensates Keychain.
        let m=World();var failConnected=true
        m.storage.beforeSave={state in if failConnected,state["phase"]as?String=="connected"{failConnected=false;throw Injected.failure}}
        do{_=try await connected(m.coordinator());fatalError("queue write must fail")}catch{precondition(error as?PhoneSourceCoordinatorError == .storageUnavailable)}
        precondition(m.keys.values.isEmpty && m.storage.record()["phase"]as?String=="stopped")

        // A later explicit reconnect must survive an older RPC completing in another manager.
        let n=World(),oldCoordinator=n.coordinator();n.host.suspendNextPublish=true
        let oldPublish=Task{try await connected(oldCoordinator)}
        for _ in 0..<100{if n.host.publishWaiting{break};try? await Task.sleep(nanoseconds:2_000_000)}
        precondition(n.host.publishWaiting)
        let replacement=n.coordinator();check(try await connected(replacement),"connected","received")
        let replacementGrant=n.storage.record()["grantId"]as!String
        n.host.releasePublish()
        do{_=try await oldPublish.value;fatalError("old grant response must be discarded")}catch{precondition(error as?PhoneSourceCoordinatorError == .authorizationChanged)}
        check(try await replacement.status(goalID:"g_fixture"),"connected","received")
        precondition(n.storage.record()["grantId"]as?String==replacementGrant && n.keys.values.count==1)

        let o=World(),oc=o.coordinator();await o.api.hold()
        let cancelled=Task{try await connected(oc)};await waitForAPI(o.api);cancelled.cancel();await o.api.release()
        do{_=try await cancelled.value;fatalError("cancelled collection must not commit")}catch{precondition(error as?PhoneSourceCoordinatorError == .cancelled)}
        precondition(o.keys.values.isEmpty);check(try await oc.status(goalID:"g_fixture"),"disconnected")
        precondition(o.host.rotations==1)

        let p=World(),pc=p.coordinator();_=try await connected(pc);let readCount=await p.api.count()
        p.host.records["g_fixture"]!.phase="disconnected"
        check(try await pc.status(goalID:"g_fixture"),"disconnected")
        let stillReadCount=await p.api.count();precondition(readCount==stillReadCount && p.keys.values.isEmpty)

        let q=World(),qc=q.coordinator();_=try await connected(qc);_=try await connected(qc,"g_other")
        precondition(q.keys.values.count==2 && q.storage.files.count==2)
        _=try await qc.disconnect(goalID:"g_fixture")
        check(try await qc.status(goalID:"g_other"),"connected","received");precondition(q.keys.values.count==1)

        // Even corrupt local records cannot smuggle a credential body through the native queue.
        let r=World(),rc=r.coordinator();_=try await connected(rc);r.host.offline=true;_=try await rc.refresh(goalID:"g_fixture")
        let file=r.storage.files.keys.first!;var corrupt=r.storage.record(),pending=corrupt["pending"]as![[String:Any]]
        var body=pending[0]["body"]as![String:Any];body["credentials"]=["secretKey":"synthetic-secret"]
        pending[0]["body"]=body;corrupt["pending"]=pending;r.storage.files[file]=try JSONSerialization.data(withJSONObject:corrupt)
        let requests=r.host.requests.count
        do{_=try await rc.status(goalID:"g_fixture");fatalError("corrupt event must be rejected locally")}catch{precondition(error as?PhoneSourceCoordinatorError == .storageUnavailable)}
        precondition(r.host.requests.count==requests)

        let s=World(),sc=s.coordinator();s.host.loseOpenOnce=true
        do{_=try await connected(sc)}catch{}
        s.host.records.removeAll()
        check(try await sc.disconnect(goalID:"g_fixture"),"disconnected","pending")
        check(try await sc.status(goalID:"g_fixture"),"disconnected","pending")
        precondition(s.host.rotations==1 && s.host.records.isEmpty,"missing intent must not be reopened by recovery")

        // A failed tombstone write still removes this scope's credential. A
        // restart must revoke the metadata-only record, never collect from it.
        let t=World(),tc=t.coordinator();_=try await connected(tc)
        t.storage.beforeSave={state in if state["phase"]as?String=="revoking"{throw Injected.failure}}
        do{_=try await tc.disconnect(goalID:"g_fixture");fatalError("failed tombstone cannot report success")}catch{precondition(error as?PhoneSourceCoordinatorError == .storageUnavailable)}
        precondition(t.keys.values.isEmpty && t.storage.record()["phase"]as?String=="connected")
        let apiBeforeRecovery=await t.api.count();t.storage.beforeSave=nil
        check(try await t.coordinator().status(goalID:"g_fixture"),"disconnected","received")
        let apiAfterRecovery=await t.api.count();precondition(apiBeforeRecovery==apiAfterRecovery)

        // If both stores fail, the current process stays blocked and explicitly
        // reports an incomplete disconnect until deletion/persistence can retry.
        let u=World(),uc=u.coordinator();_=try await connected(uc)
        u.storage.beforeSave={state in if state["phase"]as?String=="revoking"{throw Injected.failure}};u.keys.deletionFails=true
        do{_=try await uc.disconnect(goalID:"g_fixture");fatalError("double failure cannot report success")}catch{precondition(error as?PhoneSourceCoordinatorError == .credentialDeletionFailed)}
        let blockedReads=await u.api.count()
        do{_=try await uc.refresh(goalID:"g_fixture");fatalError("blocked grant cannot refresh")}catch{precondition(error as?PhoneSourceCoordinatorError == .credentialDeletionFailed)}
        uc.resumeForeground();await settle();let laterBlockedReads=await u.api.count();precondition(blockedReads==laterBlockedReads)
        u.storage.beforeSave=nil;u.keys.deletionFails=false
        check(try await uc.status(goalID:"g_fixture"),"disconnected","received");precondition(u.keys.values.isEmpty)

        // A replacement which failed before open must not lose the old grant's
        // revocation address or sequence when the user then disconnects.
        let v=World(),vc=v.coordinator();_=try await connected(vc);v.keys.deletionFails=true
        do{_=try await connected(vc);fatalError("old credential deletion must fail")}catch{precondition(error as?PhoneSourceCoordinatorError == .credentialDeletionFailed)}
        precondition(v.host.rotations==1 && v.host.records["g_fixture"]!.phase=="connected")
        v.keys.deletionFails=false
        check(try await vc.disconnect(goalID:"g_fixture"),"disconnected","received")
        precondition(v.host.rotations==1 && v.host.records["g_fixture"]!.phase=="disconnected")
        print("phone source crash recovery, same-id delivery, scoped secrets, terminal receipts, revocation races and foreground backoff passed")
    }
}
`);
    const path = name => fileURLToPath(new URL(`../ios/AlongHealth/Sources/${name}`, import.meta.url));
    const executable = join(directory, 'check');
    execFileSync('swiftc', ['-swift-version', '5', '-parse-as-library', '-module-cache-path', join(directory, 'module-cache'), path('OKXDeviceClient.swift'), path('DeviceDataCollectors.swift'), path('DeviceEventQueue.swift'), path('PhoneSourceCoordinator.swift'), harness, '-o', executable], {timeout: 90000, maxBuffer: 3_000_000});
    const output = execFileSync(executable, {encoding: 'utf8', timeout: 30000, maxBuffer: 2_000_000});
    assert.match(output, /phone source crash recovery, same-id delivery, scoped secrets, terminal receipts, revocation races and foreground backoff passed/);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
